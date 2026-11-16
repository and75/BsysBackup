import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import { basename, dirname, join } from "node:path";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { createJob, deleteJob, followReorganizationAt, excludePath, includePath, listJobs, loadJob, removeOverride, saveJob, setOverride, updateJob, type JobChanges } from "../core/job";
import { applyProposals, formatApplyLog } from "../core/applier";
import { analyzeSource, listSource, summarizeDuplicates, type SourceAnalysis } from "../core/duplicates";
import { listModels, ollamaBaseUrl, pickDefaultModel } from "../core/ollama";
import { proposeReorganization, UnreadableReplyError } from "../core/organizer";
import { loadSettings, saveSettings } from "../core/settings";
import { checkDevices, previewDiff, runBackup, summarizePreview } from "../core/runner";
import { readHistory, reportTextPath, toReportSummary } from "../core/report";
import { toAbs } from "../core/router";
import type { AiStatus, ApplyResult, DuplicateProgress, Job, ProgressInfo, ReorgPlan, ReorgProposal } from "../core/types";

let currentRun: AbortController | null = null;
let currentSearch: AbortController | null = null;
let currentProposal: AbortController | null = null;
/**
 * Ciò che Gestione file sa della cartella su cui sta lavorando: l'ultima ricerca di duplicati e l'ultima
 * proposta. Si possono applicare solo eliminazioni e proposte che l'app stessa ha calcolato e validato.
 */
interface Workspace {
  root: string;
  analysis?: SourceAnalysis;
  plan?: ReorgPlan;
}
let workspace: Workspace | null = null;
let currentApply: AbortController | null = null;

const jobsDir = () => join(app.getPath("userData"), "jobs");
const settingsPath = () => join(app.getPath("userData"), "settings.json");
const applyLogsDir = () => join(app.getPath("userData"), "riorganizzazioni");
const reportsDir = () => join(app.getPath("userData"), "reports");

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#14161a",
    autoHideMenuBar: true,
    title: `BsysBackup ${app.getVersion()}`,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      // Il preload non può chiedere la versione all'app: gliela si passa così
      additionalArguments: [`--app-version=${app.getVersion()}`],
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Il titolo della pagina sostituirebbe quello della finestra, che riporta la versione
  win.on("page-title-updated", (event) => event.preventDefault());
  win.loadFile(join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Chiudendo l'app a backup in corso, Robocopy non deve restare a copiare senza verifica né report
app.on("before-quit", () => {
  currentRun?.abort();
  currentSearch?.abort();
  currentProposal?.abort();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function workspaceFor(root: string): Workspace {
  if (workspace?.root !== root) workspace = { root };
  return workspace;
}

/**
 * Applica alla cartella le proposte date, scrive il registro e aggiorna i backup che la riguardano.
 * Dopo, ciò che si sapeva della cartella non vale più: descrive file che sono stati spostati.
 */
async function applyToFolder(sender: WebContents, root: string, proposals: ReorgProposal[]): Promise<ApplyResult> {
  if (currentRun) throw new Error("Un backup è in corso: riordina la cartella quando è finito.");
  if (currentSearch || currentProposal || currentApply) throw new Error("Un'altra operazione sulla cartella è in corso.");
  if (proposals.length === 0) throw new Error("Nessun elemento selezionato.");

  const apply = new AbortController();
  currentApply = apply;
  try {
    const outcomes = await applyProposals(root, proposals, {
      trash: (path) => shell.trashItem(path),
      signal: apply.signal,
      onProgress: (done, total) => {
        if (!sender.isDestroyed()) sender.send("reorg:progress", { done, total });
      },
    });
    workspace = { root };

    const jobs: Job[] = [];
    for (const job of await listJobs(jobsDir())) {
      const updated = followReorganizationAt(job, root, outcomes);
      if (JSON.stringify(updated) === JSON.stringify(job)) continue;
      await saveJob(jobsDir(), updated);
      jobs.push(updated);
    }

    const now = new Date();
    const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const logPath = join(applyLogsDir(), `riorganizzazione-${stamp}.txt`);
    await mkdir(applyLogsDir(), { recursive: true });
    await writeFile(logPath, formatApplyLog(root, outcomes, now), "utf-8");
    return { outcomes, jobs, logPath };
  } finally {
    currentApply = null;
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle("dialog:selectFolder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("job:list", () => listJobs(jobsDir()));

  ipcMain.handle("job:create", async (_e, args: { name: string; sourceRoot: string; defaultDestination: string }) => {
    const job = createJob(args);
    await saveJob(jobsDir(), job);
    return job;
  });

  ipcMain.handle("job:update", async (_e, args: { jobId: string; changes: JobChanges }) => {
    const updated = updateJob(await loadJob(jobsDir(), args.jobId), args.changes);
    await saveJob(jobsDir(), updated);
    return updated;
  });

  ipcMain.handle("job:delete", (_e, args: { jobId: string }) => deleteJob(jobsDir(), args.jobId));

  ipcMain.handle("job:setOverride", async (_e, args: { jobId: string; relativePath: string; destination: string }) => {
    const updated = setOverride(await loadJob(jobsDir(), args.jobId), args.relativePath, args.destination);
    await saveJob(jobsDir(), updated);
    return updated;
  });

  ipcMain.handle("job:removeOverride", async (_e, args: { jobId: string; relativePath: string }) => {
    const updated = removeOverride(await loadJob(jobsDir(), args.jobId), args.relativePath);
    await saveJob(jobsDir(), updated);
    return updated;
  });

  ipcMain.handle("job:listChildren", async (_e, args: { jobId: string; relativePath: string }) => {
    const job = await loadJob(jobsDir(), args.jobId);
    try {
      const entries = await readdir(toAbs(job.sourceRoot, args.relativePath), { withFileTypes: true });
      const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => ({ name: e.name, isDirectory: true })).sort(byName);
      const files = entries.filter((e) => e.isFile()).map((e) => ({ name: e.name, isDirectory: false })).sort(byName);
      return [...dirs, ...files];
    } catch {
      return [];
    }
  });

  ipcMain.handle("job:excludePath", async (_e, args: { jobId: string; relativePath: string; isDirectory: boolean }) => {
    const updated = excludePath(await loadJob(jobsDir(), args.jobId), args.relativePath, args.isDirectory);
    await saveJob(jobsDir(), updated);
    return updated;
  });

  ipcMain.handle("job:includePath", async (_e, args: { jobId: string; relativePath: string }) => {
    const updated = includePath(await loadJob(jobsDir(), args.jobId), args.relativePath);
    await saveJob(jobsDir(), updated);
    return updated;
  });

  ipcMain.handle("job:devices", async (_e, args: { jobId: string }) => checkDevices(await loadJob(jobsDir(), args.jobId)));

  ipcMain.handle("job:preview", async (_e, args: { jobId: string }) => {
    const job = await loadJob(jobsDir(), args.jobId);
    return summarizePreview(job, await previewDiff(job));
  });

  ipcMain.handle("job:run", async (event, args: { jobId: string }) => {
    if (currentRun) throw new Error("Un backup è già in corso.");
    if (currentApply) throw new Error("La sorgente è in corso di riorganizzazione: avvia il backup quando ha finito.");
    const run = new AbortController();
    currentRun = run;
    // Il backup ha la precedenza: una ricerca di duplicati sullo stesso disco lo rallenterebbe
    currentSearch?.abort();

    // Un messaggio per file intaserebbe l'interfaccia: al massimo uno ogni 100 ms, più i cambi di fase e l'ultimo
    let lastSent = 0;
    let lastPhase = "";
    const sendProgress = (info: ProgressInfo) => {
      const now = Date.now();
      if (info.phase === lastPhase && info.done !== info.total && now - lastSent < 100) return;
      lastSent = now;
      lastPhase = info.phase;
      if (!event.sender.isDestroyed()) event.sender.send("job:progress", info);
    };

    try {
      const job = await loadJob(jobsDir(), args.jobId);
      const report = await runBackup(job, { reportsDir: reportsDir(), onProgress: sendProgress, signal: run.signal });
      return toReportSummary(report);
    } finally {
      currentRun = null;
    }
  });

  ipcMain.handle("job:cancel", () => {
    currentRun?.abort();
  });

  ipcMain.handle("files:getFolder", async () => (await loadSettings(settingsPath())).lastFolder ?? null);

  ipcMain.handle("files:setFolder", async (_e, args: { root: string }) => {
    await saveSettings(settingsPath(), { ...(await loadSettings(settingsPath())), lastFolder: args.root });
  });

  ipcMain.handle("duplicates:find", async (event, args: { root: string }) => {
    if (currentRun) throw new Error("Un backup è in corso: cerca i duplicati quando è finito.");
    if (currentSearch) throw new Error("Una ricerca di duplicati è già in corso.");
    if (currentApply) throw new Error("La cartella è in corso di riorganizzazione.");
    const search = new AbortController();
    currentSearch = search;

    let lastSent = 0;
    const sendProgress = (info: DuplicateProgress) => {
      const now = Date.now();
      if (info.phase === "hash" && info.done !== info.total && now - lastSent < 100) return;
      lastSent = now;
      if (!event.sender.isDestroyed()) event.sender.send("duplicates:progress", info);
    };

    try {
      const space = workspaceFor(args.root);
      space.analysis = undefined;
      space.analysis = await analyzeSource(args.root, { signal: search.signal, onProgress: sendProgress });
      return summarizeDuplicates(space.analysis);
    } catch (err) {
      if (search.signal.aborted) throw new Error("Ricerca dei duplicati annullata.");
      throw err;
    } finally {
      currentSearch = null;
    }
  });

  ipcMain.handle("duplicates:cancel", () => {
    currentSearch?.abort();
  });

  // Elimina le copie scelte dall'utente nell'elenco dei duplicati, lasciando sempre almeno una copia per gruppo
  ipcMain.handle("duplicates:remove", async (event, args: { root: string; removals: { group: number; path: string }[] }): Promise<ApplyResult> => {
    const analysis = workspace?.root === args.root ? workspace.analysis : undefined;
    if (!analysis) throw new Error("L'elenco dei duplicati non è più valido: ripeti la ricerca.");
    const proposals: ReorgProposal[] = [];
    const byGroup = new Map<number, Set<string>>();
    for (const { group, path } of args.removals) byGroup.set(group, (byGroup.get(group) ?? new Set()).add(path));
    for (const [index, paths] of byGroup) {
      const group = analysis.duplicates.groups[index];
      const keep = group?.paths.find((p) => !paths.has(p));
      if (!group || !keep) throw new Error("Di ogni gruppo di duplicati deve restare almeno una copia.");
      for (const path of group.paths) if (paths.has(path)) proposals.push({ action: "removeDuplicate", from: path, to: keep, reason: "" });
    }
    return applyToFolder(event.sender, args.root, proposals);
  });

  ipcMain.handle("ai:status", async (): Promise<AiStatus> => {
    const models = await listModels(ollamaBaseUrl());
    if (!models) return { available: false, models: [], selected: null };
    const saved = (await loadSettings(settingsPath())).aiModel;
    const selected = models.some((m) => m.name === saved) ? (saved as string) : pickDefaultModel(models, totalmem());
    return { available: true, models, selected };
  });

  ipcMain.handle("ai:selectModel", async (_e, args: { model: string }) => {
    await saveSettings(settingsPath(), { ...(await loadSettings(settingsPath())), aiModel: args.model });
  });

  ipcMain.handle("ai:propose", async (event, args: { root: string; model: string }) => {
    if (currentProposal) throw new Error("Una proposta di riorganizzazione è già in preparazione.");
    const proposal = new AbortController();
    currentProposal = proposal;

    let lastSent = 0;
    const sendText = (chars: number) => {
      const now = Date.now();
      if (now - lastSent < 250) return;
      lastSent = now;
      if (!event.sender.isDestroyed()) event.sender.send("ai:progress", chars);
    };

    try {
      const space = workspaceFor(args.root);
      space.plan = undefined;
      // Se i duplicati sono già stati cercati la proposta ne tiene conto; altrimenti basta l'elenco dei file
      const analysis = space.analysis ?? (await listSource(args.root));
      proposal.signal.throwIfAborted();
      const plan = await proposeReorganization(analysis, { baseUrl: ollamaBaseUrl(), model: args.model, signal: proposal.signal, onText: sendText });
      if (workspace === space) space.plan = plan;
      return plan;
    } catch (err) {
      if (proposal.signal.aborted) throw new Error("Proposta annullata.");
      if (err instanceof UnreadableReplyError) {
        // Senza vedere cosa ha scritto il modello non si capisce perché la risposta non era leggibile
        const path = join(app.getPath("userData"), "ultima-risposta-modello.txt");
        const saved = await writeFile(path, `Modello: ${args.model}\n\n${err.raw}`, "utf-8").then(() => true, () => false);
        throw new Error(saved ? `${err.message} La risposta è stata salvata in ${path}` : err.message);
      }
      throw err;
    } finally {
      currentProposal = null;
    }
  });

  ipcMain.handle("ai:cancel", () => {
    currentProposal?.abort();
  });

  ipcMain.handle("reorg:apply", async (event, args: { root: string; indexes: number[] }): Promise<ApplyResult> => {
    const plan = workspace?.root === args.root ? workspace.plan : undefined;
    if (!plan) throw new Error("La proposta non è più valida: chiedine una nuova.");
    const proposals = [...new Set(args.indexes)].sort((a, b) => a - b).map((i) => plan.proposals[i]).filter(Boolean);
    return applyToFolder(event.sender, args.root, proposals);
  });

  ipcMain.handle("reorg:cancel", () => {
    currentApply?.abort();
  });

  ipcMain.handle("reorg:openLog", async (_e, args: { path: string }) => {
    if (dirname(args.path) !== applyLogsDir() || !/^riorganizzazione-[\d-]+\.txt$/.test(basename(args.path))) throw new Error("Registro non valido.");
    const error = await shell.openPath(args.path);
    if (error) throw new Error(`Impossibile aprire il registro: ${error}`);
  });

  ipcMain.handle("history:list", () => readHistory(reportsDir(), 20));

  ipcMain.handle("report:open", async (_e, args: { reportId: string }) => {
    const error = await shell.openPath(reportTextPath(reportsDir(), args.reportId));
    if (error) throw new Error(`Impossibile aprire il report: ${error}`);
  });
}
