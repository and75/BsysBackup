import type { DuplicateGroup, Job, PreviewSummary, ReorgAction, ReorgProposal } from "../core/types";
import {
  analyze,
  assignOverride,
  cancelDuplicates,
  cancelProposal,
  cancelRun,
  checkAi,
  changeFolder,
  clearOverride,
  deleteJob,
  destinationRoots,
  findDuplicates,
  guard,
  navigate,
  onDuplicateProgress,
  onProgress,
  onProposalProgress,
  overrideAt,
  proposeReorganization,
  refreshPreview,
  render,
  resolveDestination,
  runJob,
  selectAiModel,
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

function duplicateGroup(group: DuplicateGroup): HTMLElement {
  const isFolder = group.kind === "folder";
  const each = group.copies > 2 ? " ciascuna" : " l'una";
  const hidden = group.copies - group.paths.length;
  return h(
    "li",
    { class: "dup-group" },
    h(
      "div",
      { class: "dup-head" },
      h("span", { class: `pill ${isFolder ? "pill-info" : "pill-muted"}` }, isFolder ? "Cartella" : "File"),
      h("span", null, `${formatNumber(group.copies)} copie identiche`),
      h("span", { class: "muted" }, `${formatBytes(group.size)}${each}${isFolder ? `, ${fileCount(group.fileCount)}` : ""}`)
    ),
    h(
      "ul",
      { class: "dup-paths" },
      ...group.paths.map((path) => h("li", null, path)),
      hidden > 0 && h("li", { class: "muted" }, `… e altre ${formatNumber(hidden)}`)
    )
  );
}

function duplicatesSearching(): HTMLElement {
  const fill = h("div", { class: "progress-fill" });
  const bar = h("div", { class: "progress-bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100 }, fill);
  const label = h("span", null);
  const count = h("span", { class: "progress-count" });

  onDuplicateProgress((progress) => {
    const counting = progress?.phase === "hash" && progress.total > 0;
    const percent = counting ? Math.round((progress.done / progress.total) * 100) : 0;
    label.textContent = progress?.phase === "hash" ? "Confronto del contenuto dei file che potrebbero essere uguali" : "Lettura dell'elenco dei file";
    count.textContent = counting ? `${formatBytes(progress.done)} di ${formatBytes(progress.total)}` : "";
    fill.style.width = `${percent}%`;
    bar.classList.toggle("indeterminate", !counting);
    if (counting) bar.setAttribute("aria-valuenow", String(percent));
    else bar.removeAttribute("aria-valuenow");
  });

  return h("div", { class: "progress" }, h("div", { class: "progress-text" }, label, count), bar);
}

function duplicatesPanel(job: Job): HTMLElement {
  const search = state.duplicateSearch;
  const searchingHere = search?.jobId === job.id;
  const result = state.duplicates.get(job.id);

  const action = searchingHere
    ? h("button", { type: "button", class: "btn btn-small", disabled: search.cancelling, onclick: guard(cancelDuplicates) }, search.cancelling ? "Annullamento…" : "Annulla")
    : h(
        "button",
        { type: "button", class: "btn btn-small", disabled: search !== null || state.running !== null, onclick: guard(() => findDuplicates(job.id)) },
        result ? "Cerca di nuovo" : "Cerca duplicati"
      );
  const head = h("div", { class: "panel-head" }, h("h2", null, "Duplicati nella sorgente"), action);
  const panel = (...body: (HTMLElement | false)[]) => h("section", { class: "panel", "aria-label": "Duplicati nella sorgente" }, head, ...body);

  if (searchingHere) return panel(duplicatesSearching());
  if (result?.status === "error") return panel(h("p", { class: "warn" }, result.message));
  if (result?.status !== "ready") {
    return panel(
      h("p", { class: "muted small" }, "Trova i file e le cartelle presenti più volte con lo stesso identico contenuto. È una sola lettura: non viene spostato né cancellato nulla."),
      search !== null && h("p", { class: "muted small" }, "Una ricerca è in corso su un altro backup.")
    );
  }

  const { summary } = result;
  const unreadable = summary.unreadable > 0 && h("p", { class: "warn small" }, `${formatNumber(summary.unreadable)} cartelle o file non leggibili: non sono stati confrontati.`);
  if (summary.groups.length === 0) {
    return panel(h("p", { class: "muted" }, `Nessun duplicato fra i ${fileCount(summary.scannedFiles)} della sorgente.`), unreadable);
  }
  const copies = summary.redundantFiles === 1 ? "1 copia in più occupa" : `${formatNumber(summary.redundantFiles)} copie in più occupano`;
  return panel(
    h("p", null, `${copies} ${formatBytes(summary.recoverableBytes)}, su ${fileCount(summary.scannedFiles)} controllati.`),
    unreadable,
    h(
      "ul",
      { class: "dup-list" },
      ...summary.groups.map(duplicateGroup),
      summary.groupsOmitted > 0 && h("li", { class: "muted small" }, `… e altri ${formatNumber(summary.groupsOmitted)} gruppi più piccoli`)
    )
  );
}

const ACTION_LABELS: Record<ReorgAction, { label: string; verb: string }> = {
  move: { label: "Sposta", verb: "in" },
  merge: { label: "Unisci", verb: "dentro" },
  rename: { label: "Rinomina", verb: "in" },
  removeDuplicate: { label: "Elimina la copia", verb: "e conserva" },
};

function proposalItem(proposal: ReorgProposal): HTMLElement {
  const { label, verb } = ACTION_LABELS[proposal.action];
  return h(
    "li",
    { class: "dup-group" },
    h(
      "div",
      { class: "dup-head" },
      h("span", { class: `pill ${proposal.action === "removeDuplicate" ? "pill-warn" : "pill-info"}` }, label),
      h("span", { class: "plan-path" }, proposal.from),
      h("span", { class: "muted" }, verb),
      h("span", { class: "plan-path" }, proposal.to)
    ),
    proposal.reason && h("p", { class: "muted small" }, proposal.reason)
  );
}

function proposalRunning(): HTMLElement {
  const label = h("span", null);
  onProposalProgress((chars) => {
    label.textContent = chars > 0 ? `Il modello sta scrivendo la proposta: ${formatNumber(chars)} caratteri` : "Il modello sta leggendo l'elenco delle cartelle. Con un modello grande può volerci qualche minuto.";
  });
  return h(
    "div",
    { class: "progress" },
    h("div", { class: "progress-text" }, label),
    h("div", { class: "progress-bar indeterminate", role: "progressbar" }, h("div", { class: "progress-fill" }))
  );
}

function reorganizePanel(job: Job): HTMLElement | false {
  if (state.duplicates.get(job.id)?.status !== "ready") return false;
  const { ai, proposal } = state;
  const runningHere = proposal?.jobId === job.id;
  const result = state.plans.get(job.id);
  const title = h("h2", null, "Proposta di riorganizzazione");
  const panel = (action: HTMLElement | false, ...body: (HTMLElement | false)[]) =>
    h("section", { class: "panel", "aria-label": "Proposta di riorganizzazione" }, h("div", { class: "panel-head" }, title, action), ...body);
  const recheck = h("button", { type: "button", class: "btn btn-small", disabled: state.aiChecking, onclick: guard(checkAi) }, "Ricontrolla");

  if (runningHere) {
    const cancel = h("button", { type: "button", class: "btn btn-small", disabled: proposal.cancelling, onclick: guard(cancelProposal) }, proposal.cancelling ? "Annullamento…" : "Annulla");
    return panel(cancel, proposalRunning());
  }
  if (!ai) return panel(false, h("p", { class: "muted small" }, "Ricerca dei modelli di intelligenza artificiale installati su questo computer…"));
  if (!ai.available) {
    return panel(
      recheck,
      h("p", { class: "muted" }, "Per proporre come riordinare le cartelle serve Ollama, un programma gratuito che esegue i modelli di intelligenza artificiale su questo computer. Non risulta in esecuzione."),
      h("p", { class: "muted small" }, "Installalo da ollama.com, scarica un modello (per esempio con il comando: ollama pull gemma2:9b) e premi Ricontrolla.")
    );
  }
  if (ai.models.length === 0) {
    return panel(recheck, h("p", { class: "muted" }, "Ollama è in esecuzione ma non ha modelli installati. Scaricane uno (per esempio con il comando: ollama pull gemma2:9b) e premi Ricontrolla."));
  }

  const select = h(
    "select",
    { class: "select", "aria-label": "Modello", disabled: proposal !== null },
    ...ai.models.map((m) => h("option", { value: m.name }, `${m.name} — ${[m.parameterSize, formatBytes(m.size)].filter(Boolean).join(", ")}`))
  );
  select.value = ai.selected ?? ai.models[0].name;
  select.addEventListener("change", guard(() => selectAiModel(select.value)));
  const start = h(
    "button",
    { type: "button", class: "btn btn-small", disabled: proposal !== null, onclick: guard(() => proposeReorganization(job.id)) },
    result ? "Proponi di nuovo" : "Proponi"
  );
  const controls = h("div", { class: "plan-controls" }, h("label", { class: "plan-model" }, h("span", { class: "muted small" }, "Modello"), select), start);
  const intro = h(
    "p",
    { class: "muted small" },
    "Un modello di intelligenza artificiale in esecuzione su questo computer legge i nomi delle cartelle e i duplicati trovati, e suggerisce come riordinarli. Nulla esce dal computer e nulla viene spostato."
  );

  if (result?.status === "error") return panel(false, controls, h("p", { class: "warn" }, result.message));
  if (result?.status !== "ready") {
    return panel(false, intro, controls, proposal !== null && h("p", { class: "muted small" }, "Una proposta è in preparazione per un altro backup."));
  }
  const { plan } = result;
  return panel(
    false,
    controls,
    plan.summary !== "" && h("p", null, plan.summary),
    plan.proposals.length === 0 && h("p", { class: "muted" }, "Il modello non ha proposto modifiche."),
    plan.proposals.length > 0 && h("ul", { class: "dup-list" }, ...plan.proposals.map(proposalItem)),
    plan.discarded > 0 &&
      h(
        "p",
        { class: "muted small" },
        `${plan.discarded === 1 ? "1 proposta scartata perché indicava" : `${formatNumber(plan.discarded)} proposte scartate perché indicavano`} cartelle inesistenti o spostamenti impossibili.`
      ),
    h("p", { class: "muted small" }, `Sono suggerimenti di ${plan.model}, da valutare: l'app non sposta né cancella nulla.`)
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
        foldersPanel(job),
        duplicatesPanel(job),
        reorganizePanel(job)
      ),
      running ? runningPanel() : previewPanel(job)
    ),
  ];
}
