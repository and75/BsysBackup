/// <reference path="./global.d.ts" />
import type { DeviceStatus, Job, Override, PreviewSummary, ProgressInfo, ReportSummary } from "../core/types";

export type View = { name: "home" } | { name: "new" } | { name: "job"; jobId: string } | { name: "result"; report: ReportSummary };

export type PreviewState =
  | { status: "loading" }
  | { status: "ready"; summary: PreviewSummary }
  | { status: "error"; message: string }
  /** Analisi non avviata: la sorgente o un disco di destinazione non è collegato */
  | { status: "disconnected"; devices: DeviceStatus };

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
  error: null as string | null,
  /** false finché l'elenco dei backup non è stato letto: evita di mostrare per un attimo "nessun backup" */
  loaded: false,
  tree: { expanded: new Set<string>([""]), children: new Map<string, string[]>(), selected: null as string | null },
  showChangedList: false,
  confirmDelete: false,
  newJob: { name: "", sourceRoot: "", defaultDestination: "" },
};

let renderView: () => void = () => {};
const progressListeners = new Set<(progress: ProgressInfo | null) => void>();

export function setRenderer(fn: () => void): void {
  renderView = fn;
}

export function render(): void {
  progressListeners.clear();
  renderView();
}

/** Aggiorna un pezzo di interfaccia a ogni avanzamento, senza ricostruire la schermata */
export function onProgress(fn: (progress: ProgressInfo | null) => void): void {
  progressListeners.add(fn);
  fn(state.running?.progress ?? null);
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
  const children = await window.api.listSubfolders({ jobId, relativePath: relPath });
  if (state.view.name === "job" && state.view.jobId === jobId) state.tree.children.set(relPath, children);
}

export function navigate(view: View): void {
  state.view = view;
  state.error = null;
  state.confirmDelete = false;
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

export async function changeFolder(jobId: string, field: "sourceRoot" | "defaultDestination"): Promise<void> {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  replaceJob(await window.api.updateJob({ jobId, changes: { [field]: folder } }));
  if (field === "sourceRoot") {
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
  navigate({ name: "home" });
}

export async function runJob(jobId: string): Promise<void> {
  if (state.running) return;
  state.running = { jobId, progress: null, cancelling: false };
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

export async function openReport(reportId: string): Promise<void> {
  await window.api.openReport({ reportId });
}

window.api.onProgress((info) => {
  if (!state.running) return;
  state.running.progress = info;
  for (const listener of progressListeners) listener(info);
});

// Tornando all'app dopo aver collegato un disco, i backup in attesa vengono ricontrollati da soli
window.addEventListener("focus", guard(recheckDisconnected));
