/// <reference path="./global.d.ts" />
import type { AiStatus, ApplyResult, DeviceStatus, DuplicateProgress, DuplicateSummary, ExcludedPath, Job, Override, PreviewSummary, ProgressInfo, ReorgPlan, ReportSummary } from "../core/types";
import type { TreeChild } from "./global.js";

export type View = { name: "home" } | { name: "new" } | { name: "job"; jobId: string } | { name: "result"; report: ReportSummary };

export type PreviewState =
  | { status: "loading" }
  | { status: "ready"; summary: PreviewSummary }
  | { status: "error"; message: string }
  /** Analisi non avviata: la sorgente o un disco di destinazione non è collegato */
  | { status: "disconnected"; devices: DeviceStatus };

export type DuplicatesState = { status: "ready"; summary: DuplicateSummary } | { status: "error"; message: string };

export interface DuplicateSearch {
  jobId: string;
  progress: DuplicateProgress | null;
  cancelling: boolean;
}

export type PlanState = { status: "ready"; plan: ReorgPlan } | { status: "error"; message: string };

export interface ProposalRun {
  jobId: string;
  /** Caratteri scritti finora dal modello: 0 finché sta ancora leggendo l'elenco */
  chars: number;
  cancelling: boolean;
}

export interface Running {
  jobId: string;
  progress: ProgressInfo | null;
  cancelling: boolean;
}

export const state = {
  view: { name: "home" } as View,
  jobs: [] as Job[],
  history: [] as ReportSummary[],
  previews: new Map<string, PreviewState>(),
  running: null as Running | null,
  /** Esito dell'ultima ricerca di duplicati per ogni backup, finché l'app resta aperta */
  duplicates: new Map<string, DuplicatesState>(),
  /** La ricerca di duplicati in corso: una sola alla volta */
  duplicateSearch: null as DuplicateSearch | null,
  /** Ollama e i suoi modelli; null finché non è stato interrogato */
  ai: null as AiStatus | null,
  aiChecking: false,
  plans: new Map<string, PlanState>(),
  proposal: null as ProposalRun | null,
  /** Proposte spuntate dall'utente, per indice nell'elenco: all'inizio nessuna */
  planSelection: new Map<string, Set<number>>(),
  /** true mentre si chiede conferma prima di modificare la sorgente */
  confirmApply: false,
  applying: null as { jobId: string; done: number; total: number; cancelling: boolean } | null,
  applyResults: new Map<string, ApplyResult>(),
  error: null as string | null,
  /** false finché l'elenco dei backup non è stato letto: evita di mostrare per un attimo "nessun backup" */
  loaded: false,
  tree: { expanded: new Set<string>([""]), children: new Map<string, TreeChild[]>(), selected: null as string | null },
  showChangedList: false,
  confirmDelete: false,
  newJob: { name: "", sourceRoot: "", defaultDestination: "" },
};

let renderView: () => void = () => {};
const progressListeners = new Set<(progress: ProgressInfo | null) => void>();
const duplicateListeners = new Set<(progress: DuplicateProgress | null) => void>();
const proposalListeners = new Set<(chars: number) => void>();

export function setRenderer(fn: () => void): void {
  renderView = fn;
}

export function render(): void {
  progressListeners.clear();
  duplicateListeners.clear();
  proposalListeners.clear();
  renderView();
}

/** Aggiorna un pezzo di interfaccia a ogni avanzamento, senza ricostruire la schermata */
export function onProgress(fn: (progress: ProgressInfo | null) => void): void {
  progressListeners.add(fn);
  fn(state.running?.progress ?? null);
}

/** Come onProgress, per l'avanzamento della ricerca dei duplicati */
export function onDuplicateProgress(fn: (progress: DuplicateProgress | null) => void): void {
  duplicateListeners.add(fn);
  fn(state.duplicateSearch?.progress ?? null);
}

/** Aggiorna l'indicazione di quanto ha scritto il modello, senza ricostruire la schermata */
export function onProposalProgress(fn: (chars: number) => void): void {
  proposalListeners.add(fn);
  fn(state.proposal?.chars ?? 0);
}

function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** Esegue un'azione asincrona mostrando l'eventuale errore nella barra in alto invece di perderlo */
export function guard(action: () => Promise<void>): () => void {
  return () => {
    action().catch((err) => {
      state.error = errorMessage(err);
      render();
    });
  };
}

export function jobById(jobId: string): Job | undefined {
  return state.jobs.find((j) => j.id === jobId);
}

export function lastReportFor(jobId: string): ReportSummary | undefined {
  return state.history.find((r) => r.jobId === jobId);
}

// Stessa regola del motore: su Windows i percorsi non distinguono maiuscole e minuscole
const pathKey = (relPath: string) => (window.api.platform === "win32" ? relPath.toLowerCase() : relPath);

export function overrideAt(job: Job, relPath: string): Override | undefined {
  return job.overrides.find((o) => pathKey(o.relativePath) === pathKey(relPath));
}

/** Destinazione di una cartella: l'override più specifico che la contiene, altrimenti il default */
export function resolveDestination(job: Job, relPath: string): string {
  const key = pathKey(relPath);
  let best: Override | undefined;
  for (const ov of job.overrides) {
    const ovKey = pathKey(ov.relativePath);
    if ((key === ovKey || key.startsWith(ovKey + "/")) && (!best || ov.relativePath.length > best.relativePath.length)) best = ov;
  }
  return best?.destination ?? job.defaultDestination;
}

export function destinationRoots(job: Job): string[] {
  return [...new Set([job.defaultDestination, ...job.overrides.map((o) => o.destination)])];
}

function isWithinPath(relPath: string, ancestorRelPath: string): boolean {
  if (ancestorRelPath === "") return true;
  const rel = pathKey(relPath);
  const ancestor = pathKey(ancestorRelPath);
  return rel === ancestor || rel.startsWith(ancestor + "/");
}

/**
 * L'esclusione più vicina che riguarda relPath (se stesso o una cartella che lo contiene), se c'è.
 * Non esiste "reincludi questo file dentro la cartella esclusa": vedi il motore (router.ts).
 */
export function excludingEntry(job: Job, relPath: string): ExcludedPath | undefined {
  return job.excludedPaths.find((ex) => isWithinPath(relPath, ex.relativePath));
}

function replaceJob(job: Job): void {
  state.jobs = state.jobs.map((j) => (j.id === job.id ? job : j));
}

export async function refreshPreview(jobId: string): Promise<void> {
  state.previews.set(jobId, { status: "loading" });
  render();
  let result: PreviewState;
  try {
    result = { status: "ready", summary: await window.api.previewJob({ jobId }) };
  } catch (err) {
    result = { status: "error", message: errorMessage(err) };
  }
  if (!jobById(jobId)) return;
  state.previews.set(jobId, result);
  render();
}

/**
 * Analisi automatica: parte solo se la sorgente e tutti i dischi di destinazione sono collegati.
 * Il controllo dei dispositivi è immediato, la scansione no: inutile avviarla per poi fermarsi a metà.
 */
export async function analyze(jobId: string): Promise<void> {
  state.previews.set(jobId, { status: "loading" });
  render();
  let devices: DeviceStatus;
  try {
    devices = await window.api.checkDevices({ jobId });
  } catch (err) {
    if (jobById(jobId)) state.previews.set(jobId, { status: "error", message: errorMessage(err) });
    render();
    return;
  }
  if (!jobById(jobId)) return;
  if (!devices.sourceConnected || devices.missingDestinations.length > 0) {
    state.previews.set(jobId, { status: "disconnected", devices });
    render();
    return;
  }
  await refreshPreview(jobId);
}

let analyzing = false;

/** Analizza un backup alla volta: più scansioni insieme sullo stesso disco si rallentano a vicenda */
async function analyzeWhere(needsAnalysis: (preview: PreviewState | undefined) => boolean): Promise<void> {
  if (analyzing) return;
  analyzing = true;
  try {
    for (const job of [...state.jobs]) {
      if (state.running?.jobId !== job.id && needsAnalysis(state.previews.get(job.id))) await analyze(job.id);
    }
  } finally {
    analyzing = false;
  }
}

/** Ricontrolla i backup rimasti senza analisi perché mancava un disco: utile dopo averlo collegato */
export function recheckDisconnected(): Promise<void> {
  return analyzeWhere((preview) => preview?.status === "disconnected");
}

export async function init(): Promise<void> {
  [state.jobs, state.history] = await Promise.all([window.api.listJobs(), window.api.listHistory()]);
  state.loaded = true;
  render();
  await analyzeWhere((preview) => preview === undefined);
}

async function loadChildren(jobId: string, relPath: string): Promise<void> {
  if (state.tree.children.has(relPath)) return;
  const children = await window.api.listChildren({ jobId, relativePath: relPath });
  if (state.view.name === "job" && state.view.jobId === jobId) state.tree.children.set(relPath, children);
}

export function navigate(view: View): void {
  state.view = view;
  state.error = null;
  state.confirmDelete = false;
  state.confirmApply = false;
  state.showChangedList = false;
  if (view.name === "new") state.newJob = { name: "", sourceRoot: "", defaultDestination: "" };
  if (view.name === "job") {
    state.tree = { expanded: new Set([""]), children: new Map(), selected: null };
    const { jobId } = view;
    guard(async () => {
      await loadChildren(jobId, "");
      render();
      const current = state.previews.get(jobId);
      if (!current || current.status === "disconnected") await analyze(jobId);
      if (state.duplicates.get(jobId)?.status === "ready") await checkAi();
    })();
  }
  render();
}

export async function toggleFolder(jobId: string, relPath: string): Promise<void> {
  if (state.tree.expanded.has(relPath)) state.tree.expanded.delete(relPath);
  else {
    state.tree.expanded.add(relPath);
    await loadChildren(jobId, relPath);
  }
  render();
}

export function selectFolder(relPath: string): void {
  state.tree.selected = relPath;
  render();
}

export async function assignOverride(jobId: string, relPath: string): Promise<void> {
  const destination = await window.api.selectFolder();
  if (!destination) return;
  replaceJob(await window.api.setOverride({ jobId, relativePath: relPath, destination }));
  await analyze(jobId);
}

export async function clearOverride(jobId: string, relPath: string): Promise<void> {
  replaceJob(await window.api.removeOverride({ jobId, relativePath: relPath }));
  await analyze(jobId);
}

export async function excludePath(jobId: string, relPath: string, isDirectory: boolean): Promise<void> {
  replaceJob(await window.api.excludePath({ jobId, relativePath: relPath, isDirectory }));
  await analyze(jobId);
}

export async function includePath(jobId: string, relPath: string): Promise<void> {
  replaceJob(await window.api.includePath({ jobId, relativePath: relPath }));
  await analyze(jobId);
}

export async function changeFolder(jobId: string, field: "sourceRoot" | "defaultDestination"): Promise<void> {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  replaceJob(await window.api.updateJob({ jobId, changes: { [field]: folder } }));
  if (field === "sourceRoot") {
    state.duplicates.delete(jobId);
    forgetPlan(jobId);
    state.applyResults.delete(jobId);
    state.tree = { expanded: new Set([""]), children: new Map(), selected: null };
    await loadChildren(jobId, "");
  }
  await analyze(jobId);
}

export async function setVerifyWithHash(jobId: string, value: boolean): Promise<void> {
  replaceJob(await window.api.updateJob({ jobId, changes: { verifyWithHash: value } }));
  render();
}

export async function pickNewJobFolder(field: "sourceRoot" | "defaultDestination"): Promise<void> {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  state.newJob[field] = folder;
  render();
}

export async function createJob(): Promise<void> {
  const { name, sourceRoot, defaultDestination } = state.newJob;
  if (!name.trim() || !sourceRoot || !defaultDestination) {
    state.error = "Indica un nome, la cartella da salvare e dove salvarla.";
    render();
    return;
  }
  const job = await window.api.createJob({ name: name.trim(), sourceRoot, defaultDestination });
  state.jobs = [...state.jobs, job].sort((a, b) => a.name.localeCompare(b.name));
  navigate({ name: "job", jobId: job.id });
}

export async function deleteJob(jobId: string): Promise<void> {
  await window.api.deleteJob({ jobId });
  state.jobs = state.jobs.filter((j) => j.id !== jobId);
  state.previews.delete(jobId);
  state.duplicates.delete(jobId);
  forgetPlan(jobId);
  state.applyResults.delete(jobId);
  navigate({ name: "home" });
}

export async function runJob(jobId: string): Promise<void> {
  if (state.running) return;
  state.running = { jobId, progress: null, cancelling: false };
  // Avviando un backup la ricerca dei duplicati viene interrotta: non è un errore da mostrare
  if (state.duplicateSearch) state.duplicateSearch.cancelling = true;
  state.error = null;
  render();
  try {
    const report = await window.api.runJob({ jobId });
    state.history = [report, ...state.history];
    state.running = null;
    // Chi ha avviato il backup dalla schermata del job vede subito l'esito; dalla schermata iniziale si aggiorna la scheda
    if (state.view.name === "job" && state.view.jobId === jobId) navigate({ name: "result", report });
    else render();
  } finally {
    state.running = null;
    render();
  }
  await analyze(jobId);
}

export async function cancelRun(): Promise<void> {
  if (!state.running) return;
  state.running.cancelling = true;
  render();
  await window.api.cancelJob();
}

export async function findDuplicates(jobId: string): Promise<void> {
  if (state.duplicateSearch || state.running) return;
  const search: DuplicateSearch = { jobId, progress: null, cancelling: false };
  const sourceRoot = jobById(jobId)?.sourceRoot;
  state.duplicateSearch = search;
  state.duplicates.delete(jobId);
  forgetPlan(jobId);
  state.applyResults.delete(jobId);
  render();
  let result: DuplicatesState | null;
  try {
    result = { status: "ready", summary: await window.api.findDuplicates({ jobId }) };
  } catch (err) {
    result = search.cancelling ? null : { status: "error", message: errorMessage(err) };
  }
  state.duplicateSearch = null;
  // Se nel frattempo la sorgente è stata cambiata, l'esito riguarda un'altra cartella
  if (result && jobById(jobId)?.sourceRoot === sourceRoot) state.duplicates.set(jobId, result);
  render();
  // Con l'elenco pronto si può proporre una riorganizzazione: serve sapere se Ollama c'è e con quali modelli
  if (result?.status === "ready") await checkAi();
}

export async function cancelDuplicates(): Promise<void> {
  if (!state.duplicateSearch) return;
  state.duplicateSearch.cancelling = true;
  render();
  await window.api.cancelDuplicates();
}

function forgetPlan(jobId: string): void {
  state.plans.delete(jobId);
  state.planSelection.delete(jobId);
  state.confirmApply = false;
}

export function toggleProposal(jobId: string, index: number): void {
  const selection = state.planSelection.get(jobId) ?? new Set<number>();
  if (selection.has(index)) selection.delete(index);
  else selection.add(index);
  state.planSelection.set(jobId, selection);
  state.confirmApply = false;
  render();
}

export function askApply(confirm: boolean): void {
  state.confirmApply = confirm;
  render();
}

/** Applica alla sorgente le proposte spuntate, poi rilegge tutto: l'elenco dei duplicati e la proposta non valgono più */
export async function applyPlan(jobId: string): Promise<void> {
  const indexes = [...(state.planSelection.get(jobId) ?? [])];
  if (state.applying || state.running || indexes.length === 0) return;
  state.applying = { jobId, done: 0, total: indexes.length, cancelling: false };
  state.confirmApply = false;
  render();
  try {
    const result = await window.api.applyPlan({ jobId, indexes });
    replaceJob(result.job);
    state.applyResults.set(jobId, result);
    state.duplicates.delete(jobId);
    forgetPlan(jobId);
    if (state.view.name === "job" && state.view.jobId === jobId) {
      state.tree = { expanded: new Set([""]), children: new Map(), selected: null };
      await loadChildren(jobId, "");
    }
  } finally {
    state.applying = null;
    render();
  }
  await analyze(jobId);
}

export async function cancelApply(): Promise<void> {
  if (!state.applying) return;
  state.applying.cancelling = true;
  render();
  await window.api.cancelApply();
}

export function dismissApplyResult(jobId: string): void {
  state.applyResults.delete(jobId);
  render();
}

export async function openApplyLog(path: string): Promise<void> {
  await window.api.openApplyLog({ path });
}

export async function checkAi(): Promise<void> {
  if (state.aiChecking) return;
  state.aiChecking = true;
  render();
  try {
    state.ai = await window.api.aiStatus();
  } finally {
    state.aiChecking = false;
    render();
  }
}

export async function selectAiModel(model: string): Promise<void> {
  if (!state.ai) return;
  state.ai = { ...state.ai, selected: model };
  await window.api.selectAiModel({ model });
}

export async function proposeReorganization(jobId: string): Promise<void> {
  const model = state.ai?.selected;
  if (state.proposal || !model) return;
  const run: ProposalRun = { jobId, chars: 0, cancelling: false };
  const sourceRoot = jobById(jobId)?.sourceRoot;
  state.proposal = run;
  forgetPlan(jobId);
  render();
  let result: PlanState | null;
  try {
    result = { status: "ready", plan: await window.api.proposeReorganization({ jobId, model }) };
  } catch (err) {
    result = run.cancelling ? null : { status: "error", message: errorMessage(err) };
  }
  state.proposal = null;
  if (result && jobById(jobId)?.sourceRoot === sourceRoot && state.duplicates.get(jobId)?.status === "ready") state.plans.set(jobId, result);
  render();
}

export async function cancelProposal(): Promise<void> {
  if (!state.proposal) return;
  state.proposal.cancelling = true;
  render();
  await window.api.cancelProposal();
}

export async function openReport(reportId: string): Promise<void> {
  await window.api.openReport({ reportId });
}

window.api.onProgress((info) => {
  if (!state.running) return;
  state.running.progress = info;
  for (const listener of progressListeners) listener(info);
});

window.api.onApplyProgress((info) => {
  if (!state.applying) return;
  state.applying = { ...state.applying, ...info };
  render();
});

window.api.onProposalProgress((chars) => {
  if (!state.proposal) return;
  state.proposal.chars = chars;
  for (const listener of proposalListeners) listener(chars);
});

window.api.onDuplicateProgress((info) => {
  if (!state.duplicateSearch) return;
  state.duplicateSearch.progress = info;
  for (const listener of duplicateListeners) listener(info);
});

// Tornando all'app dopo aver collegato un disco, i backup in attesa vengono ricontrollati da soli
window.addEventListener("focus", guard(recheckDisconnected));
