import type { BackupReport, CopyResult, DestinationGroupReport, FileEntry, Job, PlannedFile, PreviewResult } from "./types";
import { isReachable, pathExists, scanDirectory } from "./scanner";
import { listDestinationRoots, planRegionCopies, resolveRegionPath } from "./router";
import { buildDiff } from "./differ";
import { copyPlannedFiles, ensureDir, isWindows, runRobocopy } from "./copier";
import { verifyCopiedFile } from "./verifier";
import { writeReportToDisk } from "./report";

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

export interface RunBackupOptions {
  reportsDir: string;
  /** Se indicato, prevale sull'impostazione del job */
  verifyWithHash?: boolean;
  /** Concorrenza della copia file-per-file (non usata con Robocopy) */
  concurrency?: number;
  onProgress?: (info: { relPath: string; done: number; total: number }) => void;
}

export async function runBackup(job: Job, opts: RunBackupOptions): Promise<BackupReport> {
  const startedAt = new Date().toISOString();
  const useHash = opts.verifyWithHash ?? job.verifyWithHash;

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

  for (const root of byDestination.keys()) {
    if (!unreachable.has(root) && !(await ensureDir(root))) unreachable.add(root);
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
  const copyErrors = new Map<string, string>();
  const sourceHashes = new Map<string, string>();

  if (isWindows) {
    const regionsWithWork = new Set(copyable.map((f) => resolveRegionPath(job, f.relPath)));
    for (const region of planRegionCopies(job)) {
      if (!regionsWithWork.has(region.relativePath)) continue;
      const result = await runRobocopy(region.sourceDir, region.destDir, region.excludeDirs);
      if (!result.ok) {
        warnings.push(`Robocopy ha segnalato errori (codice ${result.exitCode ?? "n/d"}) copiando ${region.sourceDir} in ${region.destDir}`);
      }
    }
  } else {
    for (const [root, files] of byDestination) {
      if (unreachable.has(root)) continue;
      const outcomes = await copyPlannedFiles(files, { concurrency: opts.concurrency ?? 4, computeHash: useHash });
      for (const [relPath, outcome] of outcomes) {
        if (!outcome.ok) copyErrors.set(relPath, outcome.error ?? "copia non riuscita");
        else if (outcome.sourceHash) sourceHashes.set(relPath, outcome.sourceHash);
      }
    }
  }

  // La verifica legge la destinazione dopo la copia, chiunque l'abbia eseguita: è ciò che
  // distingue "copiato" da "il copiatore non ha dato errori".
  let done = 0;
  for (const file of copyable) {
    const report = destReports.get(file.destinationRoot) as DestinationGroupReport;
    const copyError = copyErrors.get(file.relPath);
    const result: CopyResult = copyError
      ? { relPath: file.relPath, destPath: file.destPath, ok: false, verified: false, error: copyError }
      : await verifyCopiedFile(file, { useHash, knownSourceHash: sourceHashes.get(file.relPath) });
    (result.ok ? report.copied : report.failed).push(result);
    opts.onProgress?.({ relPath: file.relPath, done: ++done, total: copyable.length });
  }

  const destinations = Array.from(destReports.values());
  const report: BackupReport = {
    jobId: job.id,
    jobName: job.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalPlanned: toCopy.length,
    totalCopied: destinations.reduce((n, d) => n + d.copied.length, 0),
    totalFailed: destinations.reduce((n, d) => n + d.failed.length, 0),
    totalSkippedUnreachable: destinations.reduce((n, d) => n + d.skippedUnreachable.length, 0),
    removedFromSource: preview.removedFromSource,
    destinations,
    warnings,
  };

  await writeReportToDisk(opts.reportsDir, report);
  return report;
}
