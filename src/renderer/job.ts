import type { Job, PreviewSummary } from "../core/types";
import {
  analyze,
  assignOverride,
  cancelRun,
  changeFolder,
  clearOverride,
  deleteJob,
  destinationRoots,
  guard,
  navigate,
  onProgress,
  overrideAt,
  refreshPreview,
  render,
  resolveDestination,
  runJob,
  selectFolder,
  setVerifyWithHash,
  state,
  toggleFolder,
} from "./app.js";
import { fileCount, formatBytes, formatNumber, h, icon } from "./dom.js";

export function backLink(): HTMLElement {
  return h("button", { type: "button", class: "link back", onclick: () => navigate({ name: "home" }) }, icon("back"), "Tutti i backup");
}

function folderField(job: Job, label: string, field: "sourceRoot" | "defaultDestination"): HTMLElement {
  return h(
    "div",
    { class: "field" },
    h("div", { class: "field-text" }, h("div", { class: "field-label" }, label), h("div", { class: "field-value" }, job[field])),
    h("button", { type: "button", class: "btn", disabled: state.running !== null, onclick: guard(() => changeFolder(job.id, field)) }, "Cambia")
  );
}

function unreachableRoots(job: Job): Set<string> {
  const preview = state.previews.get(job.id);
  if (preview?.status === "disconnected") return new Set(preview.devices.missingDestinations);
  if (preview?.status !== "ready") return new Set();
  return new Set(preview.summary.destinations.filter((d) => !d.reachable).map((d) => d.destinationRoot));
}

function treeRow(job: Job, relPath: string, label: string, depth: number, missing: Set<string>): HTMLElement {
  const expanded = state.tree.expanded.has(relPath);
  const selected = state.tree.selected === relPath;
  const own = relPath === "" ? undefined : overrideAt(job, relPath);
  const destination = resolveDestination(job, relPath);
  const knownEmpty = state.tree.children.get(relPath)?.length === 0;

  const toggle = knownEmpty
    ? h("span", { class: "tree-toggle" })
    : h(
        "button",
        {
          type: "button",
          class: "tree-toggle",
          "aria-label": `${expanded ? "Chiudi" : "Apri"} ${label}`,
          "aria-expanded": String(expanded),
          onclick: guard(() => toggleFolder(job.id, relPath)),
        },
        icon(expanded ? "chevronDown" : "chevronRight", 14)
      );

  const row = h(
    "div",
    { class: `tree-row${selected ? " selected" : ""}${depth === 0 ? " root" : ""}` },
    h("span", { class: `tree-indent depth-${Math.min(depth, 8)}` }),
    toggle,
    h("button", { type: "button", class: "tree-name", "aria-pressed": String(selected), onclick: () => selectFolder(relPath) }, label),
    missing.has(destination) && h("span", { class: "warn small" }, "non collegato"),
    h("span", { class: own ? "chip" : "tree-dest" }, destination)
  );

  if (selected && relPath !== "") {
    const disabled = state.running !== null;
    row.append(
      h(
        "button",
        { type: "button", class: "btn btn-small", disabled, onclick: guard(() => assignOverride(job.id, relPath)) },
        own ? "Cambia disco" : "Scegli un disco diverso"
      )
    );
    if (own) {
      row.append(h("button", { type: "button", class: "btn btn-small", disabled, onclick: guard(() => clearOverride(job.id, relPath)) }, "Segui la cartella superiore"));
    }
  }

  const item = h("li", null, row);
  if (expanded) {
    const children = state.tree.children.get(relPath) ?? [];
    if (children.length > 0) {
      item.append(h("ul", { class: "tree-list" }, ...children.map((name) => treeRow(job, relPath ? `${relPath}/${name}` : name, name, depth + 1, missing))));
    }
  }
  return item;
}

function foldersPanel(job: Job): HTMLElement {
  return h(
    "section",
    { class: "panel grow" },
    h(
      "div",
      null,
      h("h2", null, "Cartelle e destinazioni"),
      h("p", { class: "muted small" }, "Ogni cartella segue quella che la contiene, salvo dove scegli un disco diverso. Seleziona una cartella per cambiarlo.")
    ),
    h("ul", { class: "tree-list tree" }, treeRow(job, "", job.sourceRoot, 0, unreachableRoots(job)))
  );
}

function tile(value: number, label: string, tone = ""): HTMLElement {
  return h("div", { class: "tile" }, h("div", { class: `tile-value ${tone}` }, formatNumber(value)), h("div", { class: "tile-label" }, label));
}

function changedList(summary: PreviewSummary): HTMLElement {
  // Con una sola destinazione ripeterla su ogni riga toglierebbe spazio al percorso
  const showDestination = summary.destinations.length > 1;
  return h(
    "ul",
    { class: "changed-list" },
    ...summary.changed.map((file) =>
      h(
        "li",
        null,
        h("span", { class: file.action === "new" ? "ok" : "warn" }, file.action === "new" ? "nuovo" : "modificato"),
        h(
          "span",
          { class: "changed-file" },
          h("span", { class: "path", title: file.relPath }, file.relPath),
          showDestination && h("span", { class: "muted" }, `in ${file.destinationRoot}`)
        )
      )
    ),
    summary.changedOmitted > 0 && h("li", { class: "muted" }, `… e altri ${formatNumber(summary.changedOmitted)}`)
  );
}

function previewPanel(job: Job): HTMLElement {
  const preview = state.previews.get(job.id);
  const refresh = h(
    "button",
    { type: "button", class: "btn btn-small", disabled: !preview || preview.status === "loading", onclick: guard(() => analyze(job.id)) },
    preview?.status === "disconnected" ? "Ricontrolla" : "Aggiorna"
  );
  const head = h("div", { class: "panel-head" }, h("h2", null, "Cosa cambierà"), refresh);

  if (!preview || preview.status === "loading") {
    return h("section", { class: "panel side", "aria-label": "Anteprima" }, head, h("p", { class: "muted" }, "Confronto di sorgente e destinazioni in corso…"));
  }
  if (preview.status === "error") {
    return h("section", { class: "panel side", "aria-label": "Anteprima" }, head, h("p", { class: "warn" }, preview.message));
  }
  if (preview.status === "disconnected") {
    const { devices } = preview;
    const missing = devices.sourceConnected ? devices.missingDestinations.join(", ") : job.sourceRoot;
    const canForce = devices.sourceConnected && devices.missingDestinations.length < destinationRoots(job).length;
    return h(
      "section",
      { class: "panel side", "aria-label": "Anteprima" },
      head,
      h("p", { class: "warn with-icon" }, icon("warning", 16), `${missing} non collegato`),
      h("p", { class: "muted" }, "L'analisi non è stata avviata. Collega il disco: al ritorno su questa finestra riparte da sola, oppure premi Ricontrolla."),
      canForce &&
        h(
          "div",
          { class: "side-footer" },
          h("p", { class: "muted small" }, "Puoi comunque analizzare e salvare sui dischi collegati: i file destinati al disco mancante verranno saltati."),
          h("button", { type: "button", class: "btn", disabled: state.running !== null, onclick: guard(() => refreshPreview(job.id)) }, "Analizza comunque")
        )
    );
  }

  const { summary } = preview;
  const toCopy = summary.destinations.filter((d) => d.reachable).reduce((sum, d) => sum + d.filesToCopy, 0);
  const total = summary.newFiles + summary.modifiedFiles;
  const busy = state.running !== null;

  const destinations = summary.destinations.map((d) =>
    d.reachable
      ? h("li", null, h("span", null, d.destinationRoot), h("span", { class: "muted" }, fileCount(d.filesToCopy)))
      : h("li", { class: "warn" }, h("span", { class: "with-icon" }, icon("warning", 14), `${d.destinationRoot} non collegato`), h("span", null, `${formatNumber(d.filesToCopy)} saltati`))
  );

  const hash = h("input", { type: "checkbox", disabled: busy }) as HTMLInputElement;
  hash.checked = job.verifyWithHash;
  hash.addEventListener("change", guard(() => setVerifyWithHash(job.id, hash.checked)));

  return h(
    "section",
    { class: "panel side", "aria-label": "Anteprima" },
    head,
    h(
      "div",
      { class: "tiles tiles-2" },
      tile(summary.newFiles, "nuovi", "ok"),
      tile(summary.modifiedFiles, "modificati", "warn"),
      tile(summary.unchangedFiles, "già aggiornati"),
      tile(summary.removedFromSource, "non più nella sorgente")
    ),
    total > 0 && h("p", { class: "muted small" }, `Da copiare: ${formatBytes(summary.bytesToCopy)}`),
    h("ul", { class: "dest-list" }, ...destinations),
    summary.warnings.length > 0 &&
      h("p", { class: "warn small" }, `${formatNumber(summary.warnings.length + summary.warningsOmitted)} cartelle o file non leggibili: verranno saltati.`),
    total > 0 &&
      h(
        "button",
        {
          type: "button",
          class: "link",
          "aria-expanded": String(state.showChangedList),
          onclick: () => {
            state.showChangedList = !state.showChangedList;
            render();
          },
        },
        state.showChangedList ? "Nascondi l'elenco" : `Mostra l'elenco dei ${fileCount(total)}`
      ),
    state.showChangedList && changedList(summary),
    h(
      "div",
      { class: "side-footer" },
      h("label", { class: "check" }, hash, h("span", null, "Verifica anche con hash (più lenta)")),
      h(
        "button",
        { type: "button", class: "btn btn-primary btn-large", disabled: busy || toCopy === 0, onclick: guard(() => runJob(job.id)) },
        busy
          ? "Un altro backup è in corso"
          : toCopy > 0
            ? `Avvia backup di ${fileCount(toCopy)}`
            : total > 0
              ? "Collega il disco per copiare i file"
              : "Nessun file da copiare"
      )
    )
  );
}

function phaseItem(index: number, title: string): { item: HTMLElement; marker: HTMLElement; detail: HTMLElement } {
  const marker = h("span", { class: "phase-marker" }, String(index));
  const detail = h("div", { class: "muted small" });
  const item = h("li", { class: "phase" }, marker, h("div", { class: "phase-text" }, h("div", { class: "phase-title" }, title), detail));
  return { item, marker, detail };
}

function runningPanel(): HTMLElement {
  const phases = [phaseItem(1, "Analisi"), phaseItem(2, "Copia"), phaseItem(3, "Verifica")];
  const order = ["scan", "copy", "verify"];
  const waiting = ["Confronto di sorgente e destinazioni", "Copia dei file nuovi e modificati", "Controllo di dimensione e data di ogni file copiato"];
  const fill = h("div", { class: "progress-fill" });
  const bar = h("div", { class: "progress-bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100 }, fill);

  onProgress((progress) => {
    const current = progress ? order.indexOf(progress.phase) : 0;
    phases.forEach((phase, index) => {
      phase.item.className = `phase ${index < current ? "done" : index === current ? "current" : "pending"}`;
      phase.marker.replaceChildren(index < current ? icon("check", 13) : String(index + 1));
      const counting = index === current && progress !== null && index > 0 && progress.total > 0;
      phase.detail.textContent = index < current ? "Completata" : counting ? `${formatNumber(progress.done)} di ${fileCount(progress.total)}` : waiting[index];
    });
    const counting = progress !== null && current > 0 && progress.total > 0;
    const percent = counting ? Math.round((progress.done / progress.total) * 100) : 0;
    fill.style.width = `${percent}%`;
    bar.classList.toggle("indeterminate", !counting);
    if (counting) bar.setAttribute("aria-valuenow", String(percent));
    else bar.removeAttribute("aria-valuenow");
  });

  const cancelling = state.running?.cancelling ?? false;
  return h(
    "section",
    { class: "panel side", "aria-label": "Backup in corso" },
    h("h2", null, "Backup in corso"),
    h("ol", { class: "phases" }, ...phases.map((p) => p.item)),
    bar,
    h(
      "div",
      { class: "side-footer" },
      h("p", { class: "muted small" }, "Annullando, i file già copiati restano validi e gli altri vengono ripresi al prossimo backup."),
      h("button", { type: "button", class: "btn btn-large", disabled: cancelling, onclick: guard(cancelRun) }, cancelling ? "Annullamento…" : "Annulla backup")
    )
  );
}

function deleteControl(job: Job): HTMLElement {
  if (!state.confirmDelete) {
    return h(
      "button",
      {
        type: "button",
        class: "btn btn-small",
        disabled: state.running !== null,
        onclick: () => {
          state.confirmDelete = true;
          render();
        },
      },
      "Elimina backup"
    );
  }
  return h(
    "div",
    { class: "confirm" },
    h("span", { class: "small" }, "Eliminare la configurazione? I file già copiati non vengono toccati."),
    h("button", { type: "button", class: "btn btn-small btn-danger", onclick: guard(() => deleteJob(job.id)) }, "Elimina"),
    h(
      "button",
      {
        type: "button",
        class: "btn btn-small",
        onclick: () => {
          state.confirmDelete = false;
          render();
        },
      },
      "Annulla"
    )
  );
}

export function renderJob(job: Job): HTMLElement[] {
  const header = h("header", { class: "topbar" }, h("div", { class: "topbar-title" }, backLink(), h("h1", null, job.name)), deleteControl(job));
  const running = state.running?.jobId === job.id;

  return [
    header,
    h(
      "main",
      { class: "page job-layout" },
      h(
        "div",
        { class: "job-main" },
        h("div", { class: "fields" }, folderField(job, "Sorgente", "sourceRoot"), folderField(job, "Destinazione di default", "defaultDestination")),
        foldersPanel(job)
      ),
      running ? runningPanel() : previewPanel(job)
    ),
  ];
}
