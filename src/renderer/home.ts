import type { Job, ProgressInfo, ReportSummary } from "../core/types";
import { analyze, cancelRun, destinationRoots, guard, lastReportFor, navigate, onProgress, runJob, state } from "./app.js";
import { fileCount, formatDayRelative, formatNumber, formatWhen, h, icon } from "./dom.js";

type Tone = "ok" | "warn" | "info" | "muted";

interface CardStatus {
  pill: string;
  tone: Tone;
  /** Riga sotto il percorso: cosa serve sapere adesso su questo backup */
  detail: string;
  detailTone: "muted" | "warn";
  canRun: boolean;
  /** true se l'analisi non è partita perché manca un dispositivo: la scheda offre "Ricontrolla" */
  recheck?: boolean;
}

function lastBackupText(report: ReportSummary | undefined): string {
  if (!report) return "Mai eseguito";
  const when = `Ultimo backup ${formatDayRelative(report.finishedAt)}`;
  if (report.cancelled) return `${when}: annullato, ${fileCount(report.totalInterrupted)} da riprendere`;
  const notCopied = report.totalFailed + report.totalSkippedUnreachable;
  if (notCopied > 0) return `${when}: ${fileCount(notCopied)} non copiati`;
  if (report.totalCopied === 0) return `${when}: era già aggiornato`;
  return `${when}: ${fileCount(report.totalCopied)} copiati, nessun errore`;
}

function cardStatus(job: Job): CardStatus {
  const last = lastBackupText(lastReportFor(job.id));
  const preview = state.previews.get(job.id);
  const busy = state.running !== null;

  if (!preview || preview.status === "loading") {
    return { pill: "Analisi in corso", tone: "muted", detail: last, detailTone: "muted", canRun: !busy };
  }
  if (preview.status === "disconnected") {
    const { devices } = preview;
    if (!devices.sourceConnected) {
      return { pill: "Sorgente assente", tone: "warn", detail: `Collega ${job.sourceRoot} per eseguire il backup`, detailTone: "warn", canRun: false, recheck: true };
    }
    const disks = devices.missingDestinations.join(", ");
    if (devices.missingDestinations.length === destinationRoots(job).length) {
      return { pill: "Disco assente", tone: "muted", detail: `Collega ${disks} per eseguire il backup`, detailTone: "muted", canRun: false, recheck: true };
    }
    return { pill: "Disco assente", tone: "warn", detail: `${disks} non collegato: analisi non eseguita`, detailTone: "warn", canRun: !busy, recheck: true };
  }
  if (preview.status === "error") {
    return { pill: "Sorgente assente", tone: "warn", detail: preview.message, detailTone: "warn", canRun: false };
  }

  const { summary } = preview;
  const missing = summary.destinations.filter((d) => !d.reachable);
  if (missing.length === summary.destinations.length) {
    const disks = missing.map((d) => d.destinationRoot).join(", ");
    return { pill: "Disco assente", tone: "muted", detail: `Collega ${disks} per eseguire il backup`, detailTone: "muted", canRun: false };
  }
  if (missing.length > 0) {
    const disks = missing.map((d) => d.destinationRoot).join(", ");
    return { pill: "Disco assente", tone: "warn", detail: `${disks} non collegato: i suoi file verranno saltati`, detailTone: "warn", canRun: !busy };
  }
  const toCopy = summary.newFiles + summary.modifiedFiles;
  if (toCopy > 0) return { pill: `${formatNumber(toCopy)} da copiare`, tone: "warn", detail: last, detailTone: "muted", canRun: !busy };
  return { pill: "Aggiornato", tone: "ok", detail: last, detailTone: "muted", canRun: !busy };
}

export function phaseLabel(progress: ProgressInfo | null): string {
  if (!progress || progress.phase === "scan") return "Fase 1 di 3: analisi";
  return progress.phase === "copy" ? "Fase 2 di 3: copia" : "Fase 3 di 3: verifica";
}

/** Barra con testo, aggiornata a ogni avanzamento senza ricostruire la schermata */
export function progressBlock(): HTMLElement {
  const label = h("div", { class: "progress-label" });
  const fill = h("div", { class: "progress-fill" });
  const bar = h("div", { class: "progress-bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100 }, fill);
  const count = h("div", { class: "progress-count" });

  onProgress((progress) => {
    label.textContent = phaseLabel(progress);
    const counting = progress !== null && progress.phase !== "scan" && progress.total > 0;
    const percent = counting ? Math.round((progress.done / progress.total) * 100) : 0;
    fill.style.width = `${percent}%`;
    bar.classList.toggle("indeterminate", !counting);
    if (counting) bar.setAttribute("aria-valuenow", String(percent));
    else bar.removeAttribute("aria-valuenow");
    count.textContent = counting ? `${formatNumber(progress.done)} di ${fileCount(progress.total)}` : "Confronto di sorgente e destinazioni…";
  });

  return h("div", { class: "progress" }, label, bar, count);
}

function destinationsText(job: Job): string {
  const count = destinationRoots(job).length;
  return `${job.sourceRoot}, su ${count === 1 ? "1 destinazione" : `${count} destinazioni`}`;
}

function jobCard(job: Job): HTMLElement {
  const open = h("button", { type: "button", class: "btn", onclick: () => navigate({ name: "job", jobId: job.id }) }, "Apri");

  if (state.running?.jobId === job.id) {
    const cancelling = state.running.cancelling;
    return h(
      "article",
      { class: "card card-running" },
      h("div", { class: "card-head" }, h("h2", null, job.name), h("span", { class: "pill pill-info" }, "In corso")),
      progressBlock(),
      h(
        "div",
        { class: "card-actions" },
        h("button", { type: "button", class: "btn grow", disabled: cancelling, onclick: guard(cancelRun) }, cancelling ? "Annullamento…" : "Annulla"),
        open
      )
    );
  }

  const status = cardStatus(job);
  return h(
    "article",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("h2", null, job.name),
      h("span", { class: `pill pill-${status.tone}` }, status.tone === "ok" && icon("check", 12), status.pill)
    ),
    h(
      "div",
      { class: "card-body" },
      h("div", null, destinationsText(job)),
      h("div", { class: status.detailTone }, status.detail),
      status.recheck && h("button", { type: "button", class: "link", onclick: guard(() => analyze(job.id)) }, "Ricontrolla")
    ),
    h(
      "div",
      { class: "card-actions" },
      h("button", { type: "button", class: "btn btn-primary grow", disabled: !status.canRun, onclick: guard(() => runJob(job.id)) }, "Esegui backup"),
      open
    )
  );
}

function outcome(report: ReportSummary): { text: string; tone: Tone } {
  if (report.cancelled) return { text: `Annullato, ${formatNumber(report.totalInterrupted)} da riprendere`, tone: "muted" };
  if (report.totalFailed > 0) return { text: "Con errori", tone: "warn" };
  if (report.totalSkippedUnreachable > 0) return { text: "File saltati", tone: "warn" };
  return { text: "Completato", tone: "ok" };
}

function historyTable(): HTMLElement {
  const rows = state.history.slice(0, 8).map((report) => {
    const result = outcome(report);
    return h(
      "tr",
      null,
      h("td", null, formatWhen(report.finishedAt)),
      h("td", null, report.jobName),
      h("td", { class: "num" }, formatNumber(report.totalCopied)),
      h("td", { class: "num" }, formatNumber(report.totalFailed + report.totalSkippedUnreachable)),
      h("td", { class: result.tone }, result.text),
      h("td", { class: "num" }, h("button", { type: "button", class: "link", onclick: () => navigate({ name: "result", report }) }, "Apri"))
    );
  });

  return h(
    "section",
    { class: "panel" },
    h("h2", null, "Ultimi backup"),
    rows.length === 0
      ? h("p", { class: "muted" }, "Qui comparirà l'esito di ogni backup eseguito.")
      : h(
          "div",
          { class: "table-scroll" },
          h(
            "table",
            null,
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", { scope: "col" }, "Quando"),
                h("th", { scope: "col" }, "Backup"),
                h("th", { scope: "col", class: "num" }, "Copiati"),
                h("th", { scope: "col", class: "num" }, "Non copiati"),
                h("th", { scope: "col" }, "Esito"),
                h("th", { scope: "col", class: "num" }, "Dettagli")
              )
            ),
            h("tbody", null, ...rows)
          )
        )
  );
}

export function renderHome(): HTMLElement[] {
  const newJob = () => navigate({ name: "new" });
  const header = h(
    "header",
    { class: "topbar" },
    h("div", { class: "brand" }, "Backup"),
    h("button", { type: "button", class: "btn", onclick: newJob }, "Nuovo backup")
  );

  const jobs = !state.loaded
    ? h("p", { class: "muted" }, "Caricamento…")
    : state.jobs.length === 0
      ? h(
          "div",
          { class: "panel empty" },
          h("p", null, "Non hai ancora configurato nessun backup."),
          h("button", { type: "button", class: "btn btn-primary", onclick: newJob }, "Crea il primo backup")
        )
      : h("div", { class: "cards" }, ...state.jobs.map(jobCard));

  return [header, h("main", { class: "page" }, h("section", { class: "stack" }, h("h1", null, "I tuoi backup"), jobs), historyTable())];
}
