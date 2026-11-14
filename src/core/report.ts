import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackupReport } from "./types";

export function summarizeReport(report: BackupReport): string {
  const lines: string[] = [];
  lines.push(`Backup "${report.jobName}" — ${report.startedAt} → ${report.finishedAt}`);
  lines.push(`Pianificati: ${report.totalPlanned}  Copiati OK: ${report.totalCopied}  Falliti: ${report.totalFailed}  Destinazioni irraggiungibili (saltati): ${report.totalSkippedUnreachable}`);
  for (const dest of report.destinations) {
    lines.push(`\nDestinazione: ${dest.destinationRoot} (${dest.reachable ? "raggiungibile" : "NON raggiungibile"})`);
    if (!dest.reachable) {
      lines.push(`  saltati: ${dest.skippedUnreachable.length} file`);
      continue;
    }
    lines.push(`  copiati e verificati: ${dest.copied.length}`);
    for (const f of dest.failed) {
      lines.push(`  FALLITO: ${f.relPath} — ${f.error}`);
    }
  }
  if (report.removedFromSource.length > 0) {
    lines.push(`\nFile presenti in destinazione ma non più nella sorgente (${report.removedFromSource.length}):`);
    for (const f of report.removedFromSource.slice(0, 50)) {
      lines.push(`  ${f.relPath} (${f.destinationRoot})`);
    }
  }
  return lines.join("\n");
}

export async function writeReportToDisk(reportsDir: string, report: BackupReport): Promise<{ jsonPath: string; textPath: string }> {
  await mkdir(reportsDir, { recursive: true });
  const stamp = report.finishedAt.replace(/[:.]/g, "-");
  const base = `${report.jobId}_${stamp}`;
  const jsonPath = join(reportsDir, `${base}.json`);
  const textPath = join(reportsDir, `${base}.txt`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  await writeFile(textPath, summarizeReport(report), "utf-8");
  return { jsonPath, textPath };
}
