/// <reference path="./global.d.ts" />
import type { AiStatus, ApplyOutcome, ApplyResult, DuplicateGroup, DuplicateProgress, DuplicateSummary, ReorgAction, ReorgPlan, ReorgProposal } from "../core/types";
import { analyze, errorMessage, guard, hooks, render, replaceJob, state } from "./app.js";
import { fileCount, formatBytes, formatNumber, h } from "./dom.js";

type DuplicatesState = { status: "ready"; summary: DuplicateSummary } | { status: "error"; message: string };
type PlanState = { status: "ready"; plan: ReorgPlan } | { status: "error"; message: string };
/** Da dove è partita una modifica alla cartella: dall'elenco dei duplicati o dalla proposta del modello */
type Origin = "duplicates" | "plan";

/** Gestione file lavora su una cartella alla volta, scelta dall'utente e indipendente dai backup */
export const files = {
  folder: null as string | null,
  /** false finché non è stata letta l'ultima cartella usata */
  loaded: false,
  duplicates: null as DuplicatesState | null,
  search: null as { progress: DuplicateProgress | null; cancelling: boolean } | null,
  /** Copie da eliminare spuntate dall'utente: indice del gruppo → percorsi */
  copies: new Map<number, Set<string>>(),
  /** Ollama e i suoi modelli; null finché non è stato interrogato */
  ai: null as AiStatus | null,
  aiChecking: false,
  plan: null as PlanState | null,
  /** `chars`: caratteri scritti finora dal modello, 0 finché sta ancora leggendo l'elenco */
  proposal: null as { chars: number; cancelling: boolean } | null,
  /** Proposte spuntate dall'utente, per indice nell'elenco: all'inizio nessuna */
  proposals: new Set<number>(),
  /** Quale conferma è aperta, prima di modificare la cartella */
  confirm: null as Origin | null,
  applying: null as { origin: Origin; done: number; total: number; cancelling: boolean } | null,
  result: null as (ApplyResult & { origin: Origin }) | null,
};

const searchListeners = new Set<(progress: DuplicateProgress | null) => void>();
const proposalListeners = new Set<(chars: number) => void>();

const busy = () => files.search !== null || files.proposal !== null || files.applying !== null;

hooks.beforeRender.push(() => {
  searchListeners.clear();
  proposalListeners.clear();
});

// Un backup ha la precedenza sul disco: la ricerca in corso viene interrotta, e non è un errore da mostrare
hooks.backupStarting.push(() => {
  if (files.search) files.search.cancelling = true;
});

hooks.navigated.push((view) => {
  files.confirm = null;
  if (view.name !== "duplicates" && view.name !== "reorganize" && view.name !== "settings") return;
  guard(async () => {
    if (!files.loaded) {
      files.folder = await window.api.getFilesFolder();
      files.loaded = true;
      render();
    }
    if (!files.ai && view.name !== "duplicates") await checkAi();
  })();
});

function forgetFolder(): void {
  files.duplicates = null;
  files.copies.clear();
  files.plan = null;
  files.proposals.clear();
  files.confirm = null;
}

async function openFolder(folder: string): Promise<void> {
  if (busy() || folder === files.folder) return;
  files.folder = folder;
  files.result = null;
  forgetFolder();
  render();
  await window.api.setFilesFolder({ root: folder });
}

async function chooseFolder(): Promise<void> {
  const folder = await window.api.selectFolder();
  if (folder) await openFolder(folder);
}

async function findDuplicates(): Promise<void> {
  const root = files.folder;
  if (!root || busy() || state.running) return;
  const search = { progress: null, cancelling: false };
  files.search = search;
  files.duplicates = null;
  files.copies.clear();
  if (files.result?.origin === "duplicates") files.result = null;
  render();
  let result: DuplicatesState | null;
  try {
    result = { status: "ready", summary: await window.api.findDuplicates({ root }) };
  } catch (err) {
    result = search.cancelling ? null : { status: "error", message: errorMessage(err) };
  }
  files.search = null;
  if (files.folder === root) files.duplicates = result;
  render();
}

async function cancelSearch(): Promise<void> {
  if (!files.search) return;
  files.search.cancelling = true;
  render();
  await window.api.cancelDuplicates();
}

function toggleCopy(group: number, path: string): void {
  const selected = files.copies.get(group) ?? new Set<string>();
  if (selected.has(path)) selected.delete(path);
  else selected.add(path);
  files.copies.set(group, selected);
  files.confirm = null;
  render();
}

/** Spunta tutte le copie tranne la prima di ogni gruppo, oppure nessuna */
function selectCopies(all: boolean): void {
  files.copies.clear();
  if (all && files.duplicates?.status === "ready") {
    files.duplicates.summary.groups.forEach((group, index) => files.copies.set(index, new Set(group.paths.slice(1))));
  }
  files.confirm = null;
  render();
}

async function checkAi(): Promise<void> {
  if (files.aiChecking) return;
  files.aiChecking = true;
  render();
  try {
    files.ai = await window.api.aiStatus();
  } finally {
    files.aiChecking = false;
    render();
  }
}

async function selectAiModel(model: string): Promise<void> {
  if (!files.ai) return;
  files.ai = { ...files.ai, selected: model };
  await window.api.selectAiModel({ model });
}

async function propose(): Promise<void> {
  const root = files.folder;
  const model = files.ai?.selected;
  if (!root || !model || busy()) return;
  const run = { chars: 0, cancelling: false };
  files.proposal = run;
  files.plan = null;
  files.proposals.clear();
  files.confirm = null;
  if (files.result?.origin === "plan") files.result = null;
  render();
  let result: PlanState | null;
  try {
    result = { status: "ready", plan: await window.api.proposeReorganization({ root, model }) };
  } catch (err) {
    result = run.cancelling ? null : { status: "error", message: errorMessage(err) };
  }
  files.proposal = null;
  if (files.folder === root) files.plan = result;
  render();
}

async function cancelProposal(): Promise<void> {
  if (!files.proposal) return;
  files.proposal.cancelling = true;
  render();
  await window.api.cancelProposal();
}

function toggleProposal(index: number): void {
  if (files.proposals.has(index)) files.proposals.delete(index);
  else files.proposals.add(index);
  files.confirm = null;
  render();
}

function ask(origin: Origin | null): void {
  files.confirm = origin;
  render();
}

/**
 * Modifica la cartella: elimina le copie spuntate o applica le proposte spuntate. Dopo, l'elenco dei
 * duplicati e la proposta non valgono più, perché descrivono file che sono stati spostati.
 */
async function apply(origin: Origin): Promise<void> {
  const root = files.folder;
  if (!root || busy() || state.running) return;
  const removals = [...files.copies].flatMap(([group, paths]) => [...paths].map((path) => ({ group, path })));
  const indexes = [...files.proposals];
  const total = origin === "duplicates" ? removals.length : indexes.length;
  if (total === 0) return;
  files.applying = { origin, done: 0, total, cancelling: false };
  files.confirm = null;
  render();
  try {
    const result = origin === "duplicates" ? await window.api.removeDuplicates({ root, removals }) : await window.api.applyPlan({ root, indexes });
    files.result = { ...result, origin };
    forgetFolder();
    // I backup che riguardano questa cartella hanno nuove regole e nuovi file da copiare
    for (const job of result.jobs) {
      replaceJob(job);
      state.previews.delete(job.id);
      guard(() => analyze(job.id))();
    }
  } finally {
    files.applying = null;
    render();
  }
}

async function cancelApply(): Promise<void> {
  if (!files.applying) return;
  files.applying.cancelling = true;
  render();
  await window.api.cancelApply();
}

window.api.onDuplicateProgress((info) => {
  if (!files.search) return;
  files.search.progress = info;
  for (const listener of searchListeners) listener(info);
});

window.api.onProposalProgress((chars) => {
  if (!files.proposal) return;
  files.proposal.chars = chars;
  for (const listener of proposalListeners) listener(chars);
});

window.api.onApplyProgress((info) => {
  if (!files.applying) return;
  files.applying = { ...files.applying, ...info };
  render();
});

// ---------- Schermate ----------

type Part = HTMLElement | false;

function panel(label: string, action: Part, ...body: Part[]): HTMLElement {
  return h("section", { class: "panel", "aria-label": label }, h("div", { class: "panel-head" }, h("h2", null, label), action), ...body);
}

function pageHeader(title: string): HTMLElement {
  return h("header", { class: "topbar" }, h("h1", null, title));
}

/** La cartella su cui lavorano le due sezioni di Gestione file, con le sorgenti dei backup come scorciatoie */
function folderPicker(): HTMLElement {
  const sources = [...new Map(state.jobs.map((job) => [job.sourceRoot, job.name])).entries()].filter(([root]) => root !== files.folder);
  return h(
    "section",
    { class: "stack" },
    h(
      "div",
      { class: "field" },
      h("div", { class: "field-text" }, h("div", { class: "field-label" }, "Cartella"), h("div", { class: "field-value" }, files.folder ?? "Nessuna cartella scelta")),
      h("button", { type: "button", class: files.folder ? "btn" : "btn btn-primary", disabled: busy(), onclick: guard(chooseFolder) }, files.folder ? "Cambia" : "Scegli una cartella")
    ),
    sources.length > 0 &&
      h(
        "div",
        { class: "shortcuts" },
        h("span", { class: "muted small" }, "Sorgenti dei tuoi backup:"),
        ...sources.map(([root, name]) => h("button", { type: "button", class: "btn btn-small", title: root, disabled: busy(), onclick: guard(() => openFolder(root)) }, name))
      )
  );
}

function progressBar(percent: number | null): { bar: HTMLElement; set: (percent: number | null) => void } {
  const fill = h("div", { class: "progress-fill" });
  const bar = h("div", { class: "progress-bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100 }, fill);
  const set = (value: number | null) => {
    fill.style.width = `${value ?? 0}%`;
    bar.classList.toggle("indeterminate", value === null);
    if (value === null) bar.removeAttribute("aria-valuenow");
    else bar.setAttribute("aria-valuenow", String(value));
  };
  set(percent);
  return { bar, set };
}

function applyingProgress(): HTMLElement {
  const { done, total } = files.applying ?? { done: 0, total: 0 };
  return h(
    "div",
    { class: "progress" },
    h("div", { class: "progress-text" }, h("span", null, "Modifica della cartella in corso"), h("span", { class: "progress-count" }, `${formatNumber(done)} di ${formatNumber(total)}`)),
    progressBar(total > 0 ? Math.round((done / total) * 100) : 0).bar
  );
}

function cancelButton(cancelling: boolean, action: () => Promise<void>): HTMLElement {
  return h("button", { type: "button", class: "btn btn-small", disabled: cancelling, onclick: guard(action) }, cancelling ? "Annullamento…" : "Annulla");
}

/** Riquadro di conferma prima di toccare la cartella */
function confirmBox(origin: Origin, what: string, notes: string[], action: string): HTMLElement {
  return h(
    "div",
    { class: "plan-confirm", role: "alertdialog", "aria-label": "Conferma" },
    h("p", null, what),
    h("ul", { class: "plan-notes small" }, ...notes.map((note) => h("li", null, note))),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "btn", onclick: () => ask(null) }, "Annulla"),
      h("button", { type: "button", class: "btn btn-danger", onclick: guard(() => apply(origin)) }, action)
    )
  );
}

const ACTION_LABELS: Record<ReorgAction, { label: string; verb: string }> = {
  move: { label: "Sposta", verb: "in" },
  merge: { label: "Unisci", verb: "dentro" },
  rename: { label: "Rinomina", verb: "in" },
  removeDuplicate: { label: "Elimina la copia", verb: "e conserva" },
};

function proposalText(proposal: ReorgProposal): HTMLElement {
  const { label, verb } = ACTION_LABELS[proposal.action];
  return h(
    "div",
    { class: "dup-head" },
    h("span", { class: `pill ${proposal.action === "removeDuplicate" ? "pill-warn" : "pill-info"}` }, label),
    h("span", { class: "plan-path" }, proposal.from),
    h("span", { class: "muted" }, verb),
    h("span", { class: "plan-path" }, proposal.to)
  );
}

const OUTCOME_LABELS: Record<ApplyOutcome["status"], { label: string; pill: string }> = {
  done: { label: "Fatto", pill: "pill-ok" },
  partial: { label: "In parte", pill: "pill-warn" },
  failed: { label: "Non applicata", pill: "pill-warn" },
};

/** Esito dell'ultima modifica: resta visibile finché non viene chiuso */
function resultPanel(origin: Origin): Part {
  const result = files.result;
  if (!result || result.origin !== origin) return false;
  const done = result.outcomes.filter((o) => o.status !== "failed").length;
  const close = () => {
    files.result = null;
    render();
  };
  return panel(
    "Esito",
    h("button", { type: "button", class: "btn btn-small", onclick: close }, "Chiudi"),
    h("p", null, `${formatNumber(done)} di ${formatNumber(result.outcomes.length)} modifiche applicate alla cartella.`),
    result.jobs.length > 0 && h("p", { class: "muted small" }, `Backup aggiornati alle nuove posizioni: ${result.jobs.map((job) => job.name).join(", ")}.`),
    h(
      "ul",
      { class: "dup-list" },
      ...result.outcomes.map((outcome) =>
        h(
          "li",
          { class: "dup-group" },
          h("div", { class: "dup-head" }, h("span", { class: `pill ${OUTCOME_LABELS[outcome.status].pill}` }, OUTCOME_LABELS[outcome.status].label), proposalText(outcome.proposal)),
          h("p", { class: outcome.status === "done" ? "muted small" : "warn small" }, outcome.detail)
        )
      )
    ),
    h("div", { class: "actions" }, h("button", { type: "button", class: "link", onclick: guard(() => window.api.openApplyLog({ path: result.logPath })) }, "Apri il registro delle operazioni"))
  );
}

// ---------- Rimuovi duplicati ----------

function duplicateGroup(group: DuplicateGroup, index: number): HTMLElement {
  const isFolder = group.kind === "folder";
  const selected = files.copies.get(index) ?? new Set<string>();
  const hidden = group.copies - group.paths.length;
  return h(
    "li",
    { class: "dup-group" },
    h(
      "div",
      { class: "dup-head" },
      h("span", { class: `pill ${isFolder ? "pill-info" : "pill-muted"}` }, isFolder ? "Cartella" : "File"),
      h("span", null, `${formatNumber(group.copies)} copie identiche`),
      h("span", { class: "muted" }, `${formatBytes(group.size)}${group.copies > 2 ? " ciascuna" : " l'una"}${isFolder ? `, ${fileCount(group.fileCount)}` : ""}`)
    ),
    h(
      "ul",
      { class: "dup-paths" },
      ...group.paths.map((path) => {
        const box = h("input", { type: "checkbox" }) as HTMLInputElement;
        box.checked = selected.has(path);
        // Di ogni gruppo deve restare almeno una copia: l'ultima non si può spuntare
        box.disabled = files.applying !== null || (!box.checked && selected.size >= group.copies - 1);
        box.addEventListener("change", () => toggleCopy(index, path));
        return h("li", null, h("label", { class: "dup-copy" }, box, h("span", null, path)));
      }),
      hidden > 0 && h("li", { class: "muted" }, `… e altre ${formatNumber(hidden)}, che restano`)
    )
  );
}

function searchProgress(): HTMLElement {
  const label = h("span", null);
  const count = h("span", { class: "progress-count" });
  const { bar, set } = progressBar(null);
  searchListeners.add(update);
  update(files.search?.progress ?? null);

  function update(progress: DuplicateProgress | null): void {
    const counting = progress?.phase === "hash" && progress.total > 0;
    label.textContent = progress?.phase === "hash" ? "Confronto del contenuto dei file che potrebbero essere uguali" : "Lettura dell'elenco dei file";
    count.textContent = counting ? `${formatBytes(progress.done)} di ${formatBytes(progress.total)}` : "";
    set(counting ? Math.round((progress.done / progress.total) * 100) : null);
  }
  return h("div", { class: "progress" }, h("div", { class: "progress-text" }, label, count), bar);
}

/** Barra in fondo all'elenco: quante copie sono spuntate e il pulsante per eliminarle */
function removeControls(summary: DuplicateSummary): HTMLElement {
  let count = 0;
  let bytes = 0;
  for (const [index, paths] of files.copies) {
    count += paths.size;
    bytes += paths.size * (summary.groups[index]?.size ?? 0);
  }
  const pick = h(
    "div",
    { class: "shortcuts" },
    h("button", { type: "button", class: "link", onclick: () => selectCopies(true) }, "Seleziona tutte le copie in più"),
    count > 0 && h("button", { type: "button", class: "link", onclick: () => selectCopies(false) }, "Deseleziona tutto")
  );
  if (count === 0) return h("div", { class: "stack" }, h("p", { class: "muted small" }, "Spunta le copie che vuoi eliminare: di ogni gruppo ne resta sempre almeno una."), pick);

  const what = count === 1 ? "la copia selezionata" : `le ${formatNumber(count)} copie selezionate`;
  if (files.confirm === "duplicates") {
    return confirmBox(
      "duplicates",
      `Stai per eliminare ${what} (${formatBytes(bytes)}).`,
      ["Ogni copia viene riletta: viene eliminata solo se è ancora identica a quella che resta.", "Finisce nel Cestino, da cui si può recuperare."],
      "Sposta nel Cestino"
    );
  }
  return h(
    "div",
    { class: "stack" },
    pick,
    h(
      "div",
      { class: "actions" },
      h("span", { class: "muted small" }, `${formatBytes(bytes)} da liberare`),
      h("button", { type: "button", class: "btn", disabled: state.running !== null, onclick: () => ask("duplicates") }, state.running !== null ? "Un backup è in corso" : `Elimina ${what}…`)
    )
  );
}

function duplicatesPanel(): HTMLElement {
  const title = "Duplicati";
  if (!files.folder) return panel(title, false, h("p", { class: "muted" }, "Scegli una cartella: l'app cerca i file e le cartelle presenti più volte con lo stesso identico contenuto."));
  if (files.applying?.origin === "duplicates") return panel(title, cancelButton(files.applying.cancelling, cancelApply), applyingProgress());
  if (files.search) return panel(title, cancelButton(files.search.cancelling, cancelSearch), searchProgress());

  const result = files.duplicates;
  const start = h(
    "button",
    { type: "button", class: result ? "btn btn-small" : "btn btn-small btn-primary", disabled: busy() || state.running !== null, onclick: guard(findDuplicates) },
    result ? "Cerca di nuovo" : "Cerca duplicati"
  );
  if (result?.status === "error") return panel(title, start, h("p", { class: "warn" }, result.message));
  if (result?.status !== "ready") {
    return panel(
      title,
      start,
      h("p", { class: "muted small" }, "Trova i file e le cartelle presenti più volte con lo stesso identico contenuto. La ricerca legge soltanto: decidi tu, dopo, quali copie eliminare."),
      state.running !== null && h("p", { class: "muted small" }, "Un backup è in corso: la ricerca si può avviare quando è finito.")
    );
  }

  const { summary } = result;
  const unreadable = summary.unreadable > 0 && h("p", { class: "warn small" }, `${formatNumber(summary.unreadable)} cartelle o file non leggibili: non sono stati confrontati.`);
  if (summary.groups.length === 0) return panel(title, start, h("p", { class: "muted" }, `Nessun duplicato fra i ${fileCount(summary.scannedFiles)} della cartella.`), unreadable);

  const copies = summary.redundantFiles === 1 ? "1 copia in più occupa" : `${formatNumber(summary.redundantFiles)} copie in più occupano`;
  return panel(
    title,
    start,
    h("p", null, `${copies} ${formatBytes(summary.recoverableBytes)}, su ${fileCount(summary.scannedFiles)} controllati.`),
    unreadable,
    h(
      "ul",
      { class: "dup-list" },
      ...summary.groups.map(duplicateGroup),
      summary.groupsOmitted > 0 && h("li", { class: "muted small" }, `… e altri ${formatNumber(summary.groupsOmitted)} gruppi più piccoli`)
    ),
    removeControls(summary)
  );
}

export function renderDuplicates(): HTMLElement[] {
  return [pageHeader("Rimuovi duplicati"), h("main", { class: "page narrow-wide" }, folderPicker(), duplicatesPanel(), resultPanel("duplicates"))];
}

// ---------- Riorganizza con AI ----------

/** Stato di Ollama e scelta del modello: lo stesso riquadro serve in Riorganizza e nelle Impostazioni */
function modelPicker(): { ready: boolean; content: Part[] } {
  const { ai } = files;
  const recheck = h("button", { type: "button", class: "btn btn-small", disabled: files.aiChecking, onclick: guard(checkAi) }, "Ricontrolla");
  if (!ai) return { ready: false, content: [h("p", { class: "muted small" }, "Ricerca dei modelli di intelligenza artificiale installati su questo computer…")] };
  if (!ai.available) {
    return {
      ready: false,
      content: [
        h("p", { class: "muted" }, "Serve Ollama, un programma gratuito che esegue i modelli di intelligenza artificiale su questo computer. Non risulta in esecuzione."),
        h("p", { class: "muted small" }, "Installalo da ollama.com, scarica un modello (per esempio con il comando: ollama pull gemma2:9b) e premi Ricontrolla."),
        h("div", { class: "actions" }, recheck),
      ],
    };
  }
  if (ai.models.length === 0) {
    return {
      ready: false,
      content: [h("p", { class: "muted" }, "Ollama è in esecuzione ma non ha modelli installati. Scaricane uno (per esempio con il comando: ollama pull gemma2:9b) e premi Ricontrolla."), h("div", { class: "actions" }, recheck)],
    };
  }
  const select = h(
    "select",
    { class: "select", "aria-label": "Modello", disabled: files.proposal !== null },
    ...ai.models.map((m) => h("option", { value: m.name }, `${m.name} — ${[m.parameterSize, formatBytes(m.size)].filter(Boolean).join(", ")}`))
  );
  select.value = ai.selected ?? ai.models[0].name;
  select.addEventListener("change", guard(() => selectAiModel(select.value)));
  return { ready: true, content: [h("label", { class: "plan-model" }, h("span", { class: "muted small" }, "Modello"), select)] };
}

function proposalItem(proposal: ReorgProposal, index: number): HTMLElement {
  const box = h("input", { type: "checkbox", disabled: files.applying !== null, "aria-label": `Applica: ${ACTION_LABELS[proposal.action].label} ${proposal.from}` }) as HTMLInputElement;
  box.checked = files.proposals.has(index);
  box.addEventListener("change", () => toggleProposal(index));
  return h("li", { class: "dup-group plan-item" }, box, h("div", { class: "plan-item-text" }, proposalText(proposal), proposal.reason && h("p", { class: "muted small" }, proposal.reason)));
}

function proposalRunning(): HTMLElement {
  const label = h("span", null);
  const update = (chars: number) => {
    label.textContent = chars > 0 ? `Il modello sta scrivendo la proposta: ${formatNumber(chars)} caratteri` : "Il modello sta leggendo l'elenco delle cartelle. Con un modello grande può volerci qualche minuto.";
  };
  proposalListeners.add(update);
  update(files.proposal?.chars ?? 0);
  return h("div", { class: "progress" }, h("div", { class: "progress-text" }, label), progressBar(null).bar);
}

function planControls(): Part {
  const selected = files.proposals.size;
  if (selected === 0) return h("p", { class: "muted small" }, "Spunta le proposte che vuoi applicare alla cartella.");
  const what = selected === 1 ? "la proposta selezionata" : `le ${formatNumber(selected)} proposte selezionate`;
  if (files.confirm === "plan") {
    return confirmBox(
      "plan",
      `Stai per modificare la cartella applicando ${what}.`,
      [
        "Le cartelle vengono spostate subito, senza mai sovrascrivere nulla.",
        "Ciò che viene eliminato va nel Cestino, dopo aver ricontrollato che sia ancora una copia identica.",
        "Se la cartella fa parte di un backup, al prossimo backup le cartelle spostate verranno copiate di nuovo nella nuova posizione.",
      ],
      "Applica alla cartella"
    );
  }
  return h(
    "div",
    { class: "actions" },
    h("button", { type: "button", class: "btn", disabled: state.running !== null, onclick: () => ask("plan") }, state.running !== null ? "Un backup è in corso" : `Applica ${what}…`)
  );
}

function reorganizePanel(): HTMLElement {
  const title = "Proposta";
  if (!files.folder) return panel(title, false, h("p", { class: "muted" }, "Scegli una cartella: un modello di intelligenza artificiale ne legge la struttura e suggerisce come riordinarla."));
  if (files.applying?.origin === "plan") return panel(title, cancelButton(files.applying.cancelling, cancelApply), applyingProgress());
  if (files.proposal) return panel(title, cancelButton(files.proposal.cancelling, cancelProposal), proposalRunning());

  const picker = modelPicker();
  if (!picker.ready) return panel(title, false, ...picker.content);
  const result = files.plan;
  const start = h("button", { type: "button", class: result ? "btn btn-small" : "btn btn-small btn-primary", disabled: busy(), onclick: guard(propose) }, result ? "Proponi di nuovo" : "Proponi");
  const controls = h("div", { class: "plan-controls" }, ...picker.content, start);

  if (result?.status === "error") return panel(title, false, controls, h("p", { class: "warn" }, result.message));
  if (result?.status !== "ready") {
    return panel(
      title,
      false,
      h("p", { class: "muted small" }, "Un modello in esecuzione su questo computer legge i nomi delle cartelle e suggerisce come riordinarle. Nulla esce dal computer, e nulla viene spostato senza la tua conferma."),
      h(
        "p",
        { class: "muted small" },
        files.duplicates?.status === "ready"
          ? "La proposta terrà conto dei duplicati trovati in questa cartella."
          : "Se prima cerchi i duplicati di questa cartella, la proposta ne tiene conto e può indicare le copie da eliminare."
      ),
      controls
    );
  }

  const { plan } = result;
  const discarded = plan.discarded === 1 ? "1 proposta scartata perché indicava" : `${formatNumber(plan.discarded)} proposte scartate perché indicavano`;
  return panel(
    title,
    false,
    controls,
    plan.summary !== "" && h("p", null, plan.summary),
    plan.proposals.length === 0 && h("p", { class: "muted" }, "Il modello non ha proposto modifiche."),
    plan.proposals.length > 0 && h("ul", { class: "dup-list" }, ...plan.proposals.map(proposalItem)),
    plan.truncated && h("p", { class: "warn small" }, "Il modello si è interrotto prima di finire: l'elenco può essere incompleto."),
    plan.discarded > 0 && h("p", { class: "muted small" }, `${discarded} cartelle inesistenti o spostamenti impossibili.`),
    h("p", { class: "muted small" }, `Sono suggerimenti di ${plan.model}, da valutare: nulla viene toccato finché non scegli tu cosa applicare.`),
    plan.proposals.length > 0 && planControls()
  );
}

export function renderReorganize(): HTMLElement[] {
  return [pageHeader("Riorganizza con AI"), h("main", { class: "page narrow-wide" }, folderPicker(), reorganizePanel(), resultPanel("plan"))];
}

// ---------- Impostazioni ----------

export function renderSettings(): HTMLElement[] {
  const picker = modelPicker();
  return [
    pageHeader("Impostazioni"),
    h(
      "main",
      { class: "page narrow-wide" },
      panel(
        "Intelligenza artificiale",
        picker.ready && h("button", { type: "button", class: "btn btn-small", disabled: files.aiChecking, onclick: guard(checkAi) }, "Ricontrolla"),
        h("p", { class: "muted small" }, "Il modello usato da «Riorganizza con AI». Gira su questo computer tramite Ollama: i nomi delle tue cartelle non escono dal computer."),
        ...picker.content
      ),
      panel("Informazioni", false, h("p", null, `BsysBackup, versione ${window.api.version || "sconosciuta"}`))
    ),
  ];
}
