import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackupReport } from "./types";

export function summarizeReport(report: BackupReport): string {
  const lines: string[] = [];
  lines.push(`Backup "${report.jobName}" — ${report.startedAt} → ${report.finishedAt}`);
  lines.push(`Pianificati: ${report.totalPlanned}  Copiati OK: ${report.totalCopied}  Falliti: ${report.totalFailed}  Destinazioni irraggiungibili (saltati): ${report.totalSkippedUnreachable}`);
  if (report.cancelled) {
    lines.push(`BACKUP ANNULLATO: ${report.totalInterrupted} file non copiati, verranno ripresi alla prossima esecuzione`);
  }
  for (const dest of report.destinations) {
    lines.push(`\nDestinazione: ${dest.destinationRoot} (${dest.reachable ? "raggiungibile" : "NON raggiungibile"})`);
    if (!dest.reachable) {
      lines.push(`  saltati: ${dest.skippedUnreachable.length} file`);
      continue;
    }
    const hashed = dest.copied.filter((f) => f.verified).length;
    lines.push(`  copiati e controllati (dimensione e data): ${dest.copied.length}, di cui con hash: ${hashed}`);
    for (const f of dest.failed) {
      lines.push(`  FALLITO: ${f.relPath} — ${f.error}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push(`\nAvvisi (${report.warnings.length}):`);
    for (const w of report.warnings) lines.push(`  ${w}`);
  }
  if (report.removedFromSource.length > 0) {
    const shown = report.removedFromSource.slice(0, 50);
    lines.push(`\nFile presenti in destinazione ma non più nella sorgente (${report.removedFromSource.length}), non cancellati:`);
    for (const f of shown) lines.push(`  ${f.relPath} (${f.destinationRoot})`);
    const hidden = report.removedFromSource.length - shown.length;
    if (hidden > 0) lines.push(`  … e altri ${hidden} (elenco completo nel file .json)`);
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
