import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackupReport, ReportSummary } from "./types";

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

const SUMMARY_SAMPLE_SIZE = 50;
const HISTORY_FILE = "history.jsonl";

/** Riepilogo senza gli elenchi completi dei file: è ciò che l'interfaccia mostra e che va nello storico */
export function toReportSummary(report: BackupReport): ReportSummary {
  const failures = report.destinations.flatMap((d) => d.failed.map((f) => ({ relPath: f.relPath, error: f.error ?? "errore sconosciuto" })));
  return {
    id: report.id,
    jobId: report.jobId,
    jobName: report.jobName,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    totalPlanned: report.totalPlanned,
    totalCopied: report.totalCopied,
    totalFailed: report.totalFailed,
    totalSkippedUnreachable: report.totalSkippedUnreachable,
    cancelled: report.cancelled,
    totalInterrupted: report.totalInterrupted,
    removedFromSource: report.removedFromSource.length,
    destinations: report.destinations.map((d) => ({
      destinationRoot: d.destinationRoot,
      reachable: d.reachable,
      copied: d.copied.length,
      failed: d.failed.length,
      skipped: d.skippedUnreachable.length,
    })),
    failures: failures.slice(0, SUMMARY_SAMPLE_SIZE),
    failuresOmitted: Math.max(0, failures.length - SUMMARY_SAMPLE_SIZE),
    warnings: report.warnings.slice(0, SUMMARY_SAMPLE_SIZE),
    warningsOmitted: Math.max(0, report.warnings.length - SUMMARY_SAMPLE_SIZE),
  };
}

/** Salva il report completo (.json), la versione leggibile (.txt) e aggiunge una riga allo storico */
export async function writeReportToDisk(reportsDir: string, report: BackupReport): Promise<{ jsonPath: string; textPath: string }> {
  await mkdir(reportsDir, { recursive: true });
  const jsonPath = join(reportsDir, `${report.id}.json`);
  const textPath = join(reportsDir, `${report.id}.txt`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  await writeFile(textPath, summarizeReport(report), "utf-8");
  await appendFile(join(reportsDir, HISTORY_FILE), JSON.stringify(toReportSummary(report)) + "\n", "utf-8");
  return { jsonPath, textPath };
}

/** Ultimi backup, dal più recente. Una riga illeggibile viene saltata invece di perdere tutto lo storico. */
export async function readHistory(reportsDir: string, limit = 20): Promise<ReportSummary[]> {
  let raw: string;
  try {
    raw = await readFile(join(reportsDir, HISTORY_FILE), "utf-8");
  } catch {
    return [];
  }
  const entries: ReportSummary[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as ReportSummary);
    } catch {
      // riga corrotta (es. scrittura interrotta): ignorata
    }
  }
  return entries.reverse().slice(0, limit);
}

export const REPORT_ID_PATTERN = /^[0-9a-f-]{36}_[0-9TZ-]+$/;

export function reportTextPath(reportsDir: string, reportId: string): string {
  if (!REPORT_ID_PATTERN.test(reportId)) throw new Error("Identificativo del report non valido");
  return join(reportsDir, `${reportId}.txt`);
}
