import type { BackupReport, CopyResult, DestinationGroupReport, DeviceStatus, FileEntry, Job, PlannedFile, PreviewResult, PreviewSummary, ProgressInfo } from "./types";
import { isReachable, pathExists, scanDirectory } from "./scanner";
import { listDestinationRoots, planRegionCopies, resolveRegionPath } from "./router";
import { buildDiff } from "./differ";
import { copyPlannedFiles, ensureDir, isWindows, runRobocopy } from "./copier";
import { verifyCopiedFile } from "./verifier";
import { writeReportToDisk } from "./report";

/**
 * Dice se la sorgente e i dischi di destinazione sono collegati, senza scansionare nulla:
 * serve a decidere se vale la pena avviare un'analisi.
 */
export async function checkDevices(job: Job): Promise<DeviceStatus> {
  const sourceConnected = await pathExists(job.sourceRoot);
  const missingDestinations: string[] = [];
  for (const root of listDestinationRoots(job)) {
    if (!(await isReachable(root))) missingDestinations.push(root);
  }
  return { sourceConnected, missingDestinations };
}

/**
 * Scansiona sorgente e destinazioni e calcola il diff, senza copiare né creare nulla.
 * Fallisce se la sorgente non è leggibile: trattarla come vuota farebbe sembrare
 * "rimossi" tutti i file già presenti nel backup.
 */
export async function previewDiff(job: Job): Promise<PreviewResult> {
  const warnings: string[] = [];

  let source;
  try {
    source = await scanDirectory(job.sourceRoot);
  } catch (err) {
    throw new Error(`Sorgente non leggibile: ${job.sourceRoot} (${(err as Error).message})`);
  }
  for (const s of source.skipped) warnings.push(`Sorgente, non letto: ${s}`);

  const destEntriesByRoot = new Map<string, FileEntry[]>();
  const unreachableDestinations: string[] = [];

  for (const root of listDestinationRoots(job)) {
    if (!(await isReachable(root))) {
      unreachableDestinations.push(root);
      destEntriesByRoot.set(root, []);
      continue;
    }
    if (!(await pathExists(root))) {
      destEntriesByRoot.set(root, []);
      continue;
    }
    try {
      const dest = await scanDirectory(root);
      destEntriesByRoot.set(root, dest.entries);
      for (const s of dest.skipped) warnings.push(`Destinazione, non letto: ${s}`);
    } catch {
      unreachableDestinations.push(root);
      destEntriesByRoot.set(root, []);
    }
  }

  const { planned, removedFromSource } = buildDiff(job, source.entries, destEntriesByRoot);
  return { planned, removedFromSource, unreachableDestinations, warnings };
}

const SAMPLE_SIZE = 200;
const WARNING_SAMPLE_SIZE = 50;

/** Riduce un'anteprima a conteggi e campioni: l'elenco completo può avere centinaia di migliaia di voci */
export function summarizePreview(job: Job, preview: PreviewResult): PreviewSummary {
  const unreachable = new Set(preview.unreachableDestinations);
  const changed = preview.planned.filter((f) => f.action === "new" || f.action === "modified");
  const perDestination = new Map<string, number>();
  for (const f of changed) perDestination.set(f.destinationRoot, (perDestination.get(f.destinationRoot) ?? 0) + 1);

  return {
    newFiles: changed.filter((f) => f.action === "new").length,
    modifiedFiles: changed.filter((f) => f.action === "modified").length,
    unchangedFiles: preview.planned.length - changed.length,
    removedFromSource: preview.removedFromSource.length,
    bytesToCopy: changed.reduce((sum, f) => sum + f.size, 0),
    destinations: listDestinationRoots(job).map((root) => ({
      destinationRoot: root,
      reachable: !unreachable.has(root),
      filesToCopy: perDestination.get(root) ?? 0,
    })),
    changed: changed.slice(0, SAMPLE_SIZE).map((f) => ({ action: f.action as "new" | "modified", relPath: f.relPath, destinationRoot: f.destinationRoot })),
    changedOmitted: Math.max(0, changed.length - SAMPLE_SIZE),
    warnings: preview.warnings.slice(0, WARNING_SAMPLE_SIZE),
    warningsOmitted: Math.max(0, preview.warnings.length - WARNING_SAMPLE_SIZE),
  };
}

export interface RunBackupOptions {
  reportsDir: string;
  /** Se indicato, prevale sull'impostazione del job */
  verifyWithHash?: boolean;
  /** Concorrenza della copia file-per-file (non usata con Robocopy) */
  concurrency?: number;
  onProgress?: (info: ProgressInfo) => void;
  /**
   * Annulla il backup: la copia si ferma, i file già arrivati vengono comunque controllati
   * (senza hash) e gli altri contati come interrotti. Durante l'analisi ha effetto alla sua fine.
   */
  signal?: AbortSignal;
}

export async function runBackup(job: Job, opts: RunBackupOptions): Promise<BackupReport> {
  const startedAt = new Date().toISOString();
  const useHash = opts.verifyWithHash ?? job.verifyWithHash;
  const signal = opts.signal;

  opts.onProgress?.({ phase: "scan", done: 0, total: 0 });
  const preview = await previewDiff(job);
  const warnings = [...preview.warnings];
  const toCopy = preview.planned.filter((f) => f.action === "new" || f.action === "modified");
  const unreachable = new Set(preview.unreachableDestinations);

  const byDestination = new Map<string, PlannedFile[]>();
  for (const f of toCopy) {
    const list = byDestination.get(f.destinationRoot) ?? [];
    list.push(f);
    byDestination.set(f.destinationRoot, list);
  }

  if (!signal?.aborted) {
    for (const root of byDestination.keys()) {
      if (!unreachable.has(root) && !(await ensureDir(root))) unreachable.add(root);
    }
  }

  const destReports = new Map<string, DestinationGroupReport>();
  for (const root of listDestinationRoots(job)) {
    const reachable = !unreachable.has(root);
    destReports.set(root, {
      destinationRoot: root,
      reachable,
      copied: [],
      failed: [],
      skippedUnreachable: reachable ? [] : byDestination.get(root) ?? [],
    });
  }

  const copyable = toCopy.filter((f) => !unreachable.has(f.destinationRoot));
  const total = copyable.length;
  const copyErrors = new Map<string, string>();
  const sourceHashes = new Map<string, string>();

  let copyDone = 0;
  const reportCopy = (relPath?: string) => opts.onProgress?.({ phase: "copy", done: copyDone, total, relPath });
  if (total > 0) reportCopy();

  if (isWindows) {
    const filesPerRegion = new Map<string, number>();
    for (const f of copyable) {
      const key = resolveRegionPath(job, f.relPath);
      filesPerRegion.set(key, (filesPerRegion.get(key) ?? 0) + 1);
    }
    for (const region of planRegionCopies(job)) {
      const regionTotal = filesPerRegion.get(region.relativePath) ?? 0;
      if (regionTotal === 0 || signal?.aborted) continue;
      const doneBefore = copyDone;
      let listed = 0;
      const result = await runRobocopy(region.sourceDir, region.destDir, region.excludeDirs, {
        signal,
        onFile: () => {
          // Robocopy elenca anche i tentativi falliti: il contatore non supera i file attesi
          copyDone = doneBefore + Math.min(++listed, regionTotal);
          reportCopy();
        },
      });
      if (!result.ok && !result.cancelled) {
        warnings.push(`Robocopy ha segnalato errori (codice ${result.exitCode ?? "n/d"}) copiando ${region.sourceDir} in ${region.destDir}`);
      }
    }
  } else {
    for (const [root, files] of byDestination) {
      if (unreachable.has(root) || signal?.aborted) continue;
      const outcomes = await copyPlannedFiles(files, {
        concurrency: opts.concurrency ?? 4,
        computeHash: useHash,
        signal,
        onFile: (relPath) => {
          copyDone++;
          reportCopy(relPath);
        },
      });
      for (const [relPath, outcome] of outcomes) {
        if (!outcome.ok) copyErrors.set(relPath, outcome.error ?? "copia non riuscita");
        else if (outcome.sourceHash) sourceHashes.set(relPath, outcome.sourceHash);
      }
    }
  }

  // Se l'annullamento arriva a copia finita, i file ci sono tutti: un controllo fallito è un vero errore
  const cancelledDuringCopy = Boolean(signal?.aborted);

  // La verifica legge la destinazione dopo la copia, chiunque l'abbia eseguita: è ciò che
  // distingue "copiato" da "il copiatore non ha dato errori".
  let verifyDone = 0;
  let totalInterrupted = 0;
  for (const file of copyable) {
    const report = destReports.get(file.destinationRoot) as DestinationGroupReport;
    const copyError = copyErrors.get(file.relPath);
    const result: CopyResult = copyError
      ? { relPath: file.relPath, destPath: file.destPath, ok: false, verified: false, error: copyError }
      : await verifyCopiedFile(file, { useHash: useHash && !signal?.aborted, knownSourceHash: sourceHashes.get(file.relPath) });

    if (result.ok) report.copied.push(result);
    else if (cancelledDuringCopy && !copyError) totalInterrupted++;
    else report.failed.push(result);
    opts.onProgress?.({ phase: "verify", done: ++verifyDone, total, relPath: file.relPath });
  }

  const destinations = Array.from(destReports.values());
  const finishedAt = new Date().toISOString();
  const report: BackupReport = {
    id: `${job.id}_${finishedAt.replace(/[:.]/g, "-")}`,
    jobId: job.id,
    jobName: job.name,
    startedAt,
    finishedAt,
    totalPlanned: toCopy.length,
    totalCopied: destinations.reduce((n, d) => n + d.copied.length, 0),
    totalFailed: destinations.reduce((n, d) => n + d.failed.length, 0),
    totalSkippedUnreachable: destinations.reduce((n, d) => n + d.skippedUnreachable.length, 0),
    cancelled: Boolean(signal?.aborted),
    totalInterrupted,
    removedFromSource: preview.removedFromSource,
    destinations,
    warnings,
  };

  await writeReportToDisk(opts.reportsDir, report);
  return report;
}
