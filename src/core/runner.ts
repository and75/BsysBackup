import { join } from "node:path";
import type { BackupReport, CopyResult, DestinationGroupReport, Job, PlannedFile } from "./types";
import { scanDirectory } from "./scanner";
import { listDestinationRoots, buildRegions, computeExcludeRelPaths } from "./router";
import { buildDiff } from "./differ";
import { ensureDir, runRobocopy, copyPlannedFiles, isWindows } from "./copier";
import { verifyCopiedFile } from "./verifier";
import { writeReportToDisk } from "./report";

export interface PreviewResult {
  planned: PlannedFile[];
  removedFromSource: PlannedFile[];
  unreachableDestinations: string[];
}

/** Scansiona sorgente e destinazioni e calcola il diff, senza copiare nulla. Usato per l'anteprima in UI. */
export async function previewDiff(job: Job): Promise<PreviewResult> {
  const sourceEntries = await scanDirectory(job.sourceRoot);
  const destRoots = listDestinationRoots(job);

  const destEntriesByRoot = new Map<string, Awaited<ReturnType<typeof scanDirectory>>>();
  const unreachableDestinations: string[] = [];

  for (const root of destRoots) {
    const reachable = await ensureDir(root);
    if (!reachable) {
      unreachableDestinations.push(root);
      destEntriesByRoot.set(root, []);
      continue;
    }
    destEntriesByRoot.set(root, await scanDirectory(root));
  }

  const { planned, removedFromSource } = buildDiff(job, sourceEntries, destEntriesByRoot);
  return { planned, removedFromSource, unreachableDestinations };
}

export interface RunBackupOptions {
  reportsDir: string;
  /** Concorrenza usata solo nel fallback non-Windows */
  concurrency?: number;
  onProgress?: (info: { relPath: string; done: number; total: number }) => void;
}

export async function runBackup(job: Job, opts: RunBackupOptions): Promise<BackupReport> {
  const startedAt = new Date().toISOString();
  const { planned, removedFromSource, unreachableDestinations } = await previewDiff(job);

  const toCopy = planned.filter((f) => f.action === "new" || f.action === "modified");
  const unreachableSet = new Set(unreachableDestinations);

  const byDestination = new Map<string, PlannedFile[]>();
  for (const f of toCopy) {
    const list = byDestination.get(f.destinationRoot) ?? [];
    list.push(f);
    byDestination.set(f.destinationRoot, list);
  }

  const destinationRoots = listDestinationRoots(job);
  const destReports = new Map<string, DestinationGroupReport>();
  for (const root of destinationRoots) {
    destReports.set(root, {
      destinationRoot: root,
      reachable: !unreachableSet.has(root),
      copied: [],
      failed: [],
      skippedUnreachable: [],
    });
  }

  for (const [root, files] of byDestination) {
    const report = destReports.get(root);
    if (report && !report.reachable) {
      report.skippedUnreachable.push(...files);
    }
  }

  // Fase di copia fisica, solo per le destinazioni raggiungibili.
  if (isWindows) {
    const regions = buildRegions(job);
    for (const region of regions) {
      const report = destReports.get(region.destination);
      if (!report || !report.reachable) continue;
      const sourceSub = region.relativePath ? join(job.sourceRoot, ...region.relativePath.split("/")) : job.sourceRoot;
      const excludeAbs = computeExcludeRelPaths(regions, region).map((rel) => join(job.sourceRoot, ...rel.split("/")));
      await runRobocopy(sourceSub, region.destination, excludeAbs);
    }
  } else {
    for (const [root, files] of byDestination) {
      const report = destReports.get(root);
      if (!report || !report.reachable) continue;
      await copyPlannedFiles(files, { concurrency: opts.concurrency ?? 4, computeHash: job.verifyWithHash });
    }
  }

  // Fase di verifica: sempre eseguita sui file delle destinazioni raggiungibili, indipendentemente
  // da come sono stati fisicamente copiati (Robocopy o fallback) — è la garanzia che chiedevi.
  let done = 0;
  const total = toCopy.filter((f) => !unreachableSet.has(f.destinationRoot)).length;
  for (const [root, files] of byDestination) {
    const report = destReports.get(root);
    if (!report || !report.reachable) continue;
    for (const file of files) {
      const result: CopyResult = await verifyCopiedFile(file, { useHash: job.verifyWithHash });
      if (result.ok) report.copied.push(result);
      else report.failed.push(result);
      done++;
      opts.onProgress?.({ relPath: file.relPath, done, total });
    }
  }

  const finishedAt = new Date().toISOString();
  const destinations = Array.from(destReports.values());
  const report: BackupReport = {
    jobId: job.id,
    jobName: job.name,
    startedAt,
    finishedAt,
    totalPlanned: toCopy.length,
    totalCopied: destinations.reduce((n, d) => n + d.copied.length, 0),
    totalFailed: destinations.reduce((n, d) => n + d.failed.length, 0),
    totalSkippedUnreachable: destinations.reduce((n, d) => n + d.skippedUnreachable.length, 0),
    removedFromSource,
    destinations,
  };

  await writeReportToDisk(opts.reportsDir, report);
  return report;
}
