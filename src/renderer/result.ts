import type { DestinationSummary, ReportSummary } from "../core/types";
import { guard, jobById, navigate, openReport, runJob, state } from "./app.js";
import { fileCount, formatNumber, formatWhen, h, icon } from "./dom.js";
import { backLink } from "./job.js";

function headline(report: ReportSummary): { title: string; detail: string; ok: boolean } {
  if (report.cancelled) {
    return {
      title: `Backup annullato, ${fileCount(report.totalInterrupted)} da riprendere`,
      detail: "I file già copiati sono stati controllati e restano validi. Gli altri verranno copiati al prossimo backup.",
      ok: false,
    };
  }
  if (report.totalFailed > 0) {
    return { title: `Backup completato con errori: ${fileCount(report.totalFailed)} non copiati`, detail: "L'elenco dei file non copiati è qui sotto.", ok: false };
  }
  if (report.totalSkippedUnreachable > 0) {
    return {
      title: `Backup completato, ${fileCount(report.totalSkippedUnreachable)} saltati`,
      detail: "Tutti i file copiati sono stati controllati. Un disco non era collegato.",
      ok: false,
    };
  }
  if (report.totalCopied === 0) return { title: "Il backup era già aggiornato", detail: "Non c'era nessun file nuovo o modificato da copiare.", ok: true };
  return { title: "Backup completato", detail: "Tutti i file copiati sono stati controllati.", ok: true };
}

function tile(value: number, label: string, tone = "", highlight = false): HTMLElement {
  return h(
    "div",
    { class: `tile tile-large${highlight ? " tile-warn" : ""}` },
    h("div", { class: `tile-value ${tone}` }, formatNumber(value)),
    h("div", { class: "tile-label" }, label)
  );
}

function destinationRow(dest: DestinationSummary): HTMLElement {
  if (!dest.reachable) {
    return h(
      "li",
      { class: "dest-row dest-warn" },
      h("span", { class: "with-icon" }, icon("warning", 18), h("span", { class: "strong" }, dest.destinationRoot)),
      h("span", null, `Non collegato: ${fileCount(dest.skipped)} non copiati`)
    );
  }
  const text = dest.failed > 0 ? `${fileCount(dest.copied)} copiati, ${formatNumber(dest.failed)} non riusciti` : `${fileCount(dest.copied)} copiati e controllati`;
  return h(
    "li",
    { class: `dest-row${dest.failed > 0 ? " dest-warn" : ""}` },
    h("span", { class: "with-icon" }, dest.failed > 0 ? icon("warning", 18) : h("span", { class: "badge-ok" }, icon("check", 13)), h("span", { class: "strong" }, dest.destinationRoot)),
    h("span", null, text)
  );
}

export function renderResult(report: ReportSummary): HTMLElement[] {
  const head = headline(report);
  const pending = report.totalFailed + report.totalSkippedUnreachable + report.totalInterrupted;
  const job = jobById(report.jobId);

  const header = h("header", { class: "topbar" }, h("div", { class: "topbar-title" }, backLink(), h("div", { class: "topbar-name" }, report.jobName)));

  const failures =
    report.failures.length > 0 &&
    h(
      "section",
      { class: "panel" },
      h("h2", null, "File non copiati"),
      h(
        "ul",
        { class: "plain-list" },
        ...report.failures.map((f) => h("li", null, h("span", { class: "path", title: f.relPath }, f.relPath), h("span", { class: "warn" }, f.error))),
        report.failuresOmitted > 0 && h("li", { class: "muted" }, `… e altri ${formatNumber(report.failuresOmitted)}, nel report completo`)
      )
    );

  const warnings =
    report.warnings.length > 0 &&
    h(
      "section",
      { class: "panel" },
      h("h2", null, "Avvisi"),
      h(
        "ul",
        { class: "plain-list" },
        ...report.warnings.map((w) => h("li", null, w)),
        report.warningsOmitted > 0 && h("li", { class: "muted" }, `… e altri ${formatNumber(report.warningsOmitted)}, nel report completo`)
      )
    );

  return [
    header,
    h(
      "main",
      { class: "page" },
      h(
        "div",
        { class: "headline" },
        h("span", { class: `headline-icon ${head.ok ? "ok" : "warn"}` }, icon(head.ok ? "check" : "warning", 26)),
        h("div", null, h("h1", null, head.title), h("p", { class: "muted" }, head.detail), h("p", { class: "muted small" }, `Eseguito: ${formatWhen(report.finishedAt)}`))
      ),
      h(
        "div",
        { class: "tiles tiles-4" },
        tile(report.totalCopied, "copiati e controllati", "ok"),
        tile(report.totalFailed, "non riusciti", report.totalFailed > 0 ? "warn" : "", report.totalFailed > 0),
        report.cancelled
          ? tile(report.totalInterrupted, "non copiati per l'annullamento", "warn", report.totalInterrupted > 0)
          : tile(report.totalSkippedUnreachable, "saltati, disco non collegato", report.totalSkippedUnreachable > 0 ? "warn" : "", report.totalSkippedUnreachable > 0),
        tile(report.removedFromSource, "non più nella sorgente, restano nel backup")
      ),
      h("section", { class: "panel" }, h("h2", null, "Disco per disco"), h("ul", { class: "dest-rows" }, ...report.destinations.map(destinationRow))),
      failures,
      warnings,
      h(
        "div",
        { class: "actions" },
        pending > 0 &&
          job &&
          h(
            "button",
            {
              type: "button",
              class: "btn",
              disabled: state.running !== null,
              onclick: guard(async () => {
                navigate({ name: "job", jobId: job.id });
                await runJob(job.id);
              }),
            },
            `Riprova i ${fileCount(pending)}`
          ),
        h("button", { type: "button", class: "btn", onclick: guard(() => openReport(report.id)) }, "Apri il report completo"),
        h("button", { type: "button", class: "btn btn-primary", onclick: () => navigate({ name: "home" }) }, "Torna ai backup")
      )
    ),
  ];
}
