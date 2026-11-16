import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { basename, dirname, join } from "node:path";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { createJob, deleteJob, followReorganization, excludePath, includePath, listJobs, loadJob, removeOverride, saveJob, setOverride, updateJob, type JobChanges } from "../core/job";
import { applyProposals, formatApplyLog } from "../core/applier";
import { analyzeSource, listSource, summarizeDuplicates, type SourceAnalysis } from "../core/duplicates";
import { listModels, ollamaBaseUrl, pickDefaultModel } from "../core/ollama";
import { proposeReorganization, UnreadableReplyError } from "../core/organizer";
import { loadSettings, saveSettings } from "../core/settings";
import { checkDevices, previewDiff, runBackup, summarizePreview } from "../core/runner";
import { readHistory, reportTextPath, toReportSummary } from "../core/report";
import { isExcluded, toAbs } from "../core/router";
import type { AiStatus, ApplyResult, DuplicateProgress, ProgressInfo, ReorgPlan } from "../core/types";

let currentRun: AbortController | null = null;
let currentSearch: AbortController | null = null;
let currentProposal: AbortController | null = null;
/** Ultima ricerca di duplicati per backup: è il punto di partenza della proposta di riorganizzazione */
const analyses = new Map<string, SourceAnalysis>();
/** Ultima proposta per backup: si possono applicare solo le proposte che l'app stessa ha validato */
const plans = new Map<string, { sourceRoot: string; plan: ReorgPlan }>();
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
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
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

  ipcMain.handle("job:delete", (_e, args: { jobId: string }) => {
    analyses.delete(args.jobId);
    return deleteJob(jobsDir(), args.jobId);
  });

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

  ipcMain.handle("duplicates:find", async (event, args: { jobId: string }) => {
    if (currentRun) throw new Error("Un backup è in corso: cerca i duplicati quando è finito.");
    if (currentSearch) throw new Error("Una ricerca di duplicati è già in corso.");
    if (currentApply) throw new Error("La sorgente è in corso di riorganizzazione.");
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
      const job = await loadJob(jobsDir(), args.jobId);
      analyses.delete(job.id);
      // Ciò che è escluso dal backup resta fuori anche da qui: spesso è escluso proprio perché ingombrante o irrilevante
      const analysis = await analyzeSource(job.sourceRoot, {
        signal: search.signal,
        onProgress: sendProgress,
        shouldSkip: (relPath) => isExcluded(job, relPath),
      });
      analyses.set(job.id, analysis);
      return summarizeDuplicates(analysis);
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

  ipcMain.handle("ai:propose", async (event, args: { jobId: string; model: string }) => {
    if (currentProposal) throw new Error("Una proposta di riorganizzazione è già in preparazione.");
    const job = await loadJob(jobsDir(), args.jobId);
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
      plans.delete(job.id);
      // Se i duplicati sono già stati cercati la proposta ne tiene conto; altrimenti basta l'elenco dei file
      const searched = analyses.get(job.id);
      const analysis = searched?.sourceRoot === job.sourceRoot ? searched : await listSource(job.sourceRoot, (relPath) => isExcluded(job, relPath));
      proposal.signal.throwIfAborted();
      const plan = await proposeReorganization(analysis, { baseUrl: ollamaBaseUrl(), model: args.model, signal: proposal.signal, onText: sendText });
      plans.set(job.id, { sourceRoot: job.sourceRoot, plan });
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

  ipcMain.handle("reorg:apply", async (event, args: { jobId: string; indexes: number[] }): Promise<ApplyResult> => {
    if (currentRun) throw new Error("Un backup è in corso: riordina la sorgente quando è finito.");
    if (currentSearch || currentProposal || currentApply) throw new Error("Un'altra operazione sulla sorgente è in corso.");
    const job = await loadJob(jobsDir(), args.jobId);
    const stored = plans.get(job.id);
    if (!stored || stored.sourceRoot !== job.sourceRoot) throw new Error("La proposta non è più valida: chiedine una nuova.");
    const proposals = [...new Set(args.indexes)].sort((a, b) => a - b).map((i) => stored.plan.proposals[i]).filter(Boolean);
    if (proposals.length === 0) throw new Error("Nessuna proposta selezionata.");

    const apply = new AbortController();
    currentApply = apply;
    try {
      const outcomes = await applyProposals(job.sourceRoot, proposals, {
        trash: (path) => shell.trashItem(path),
        signal: apply.signal,
        onProgress: (done, total) => {
          if (!event.sender.isDestroyed()) event.sender.send("reorg:progress", { done, total });
        },
      });
      // La sorgente è cambiata: l'elenco dei duplicati e la proposta descrivono cartelle che non ci sono più
      analyses.delete(job.id);
      plans.delete(job.id);
      const updated = followReorganization(job, outcomes);
      await saveJob(jobsDir(), updated);

      const now = new Date();
      const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
      const logPath = join(applyLogsDir(), `riorganizzazione-${stamp}.txt`);
      await mkdir(applyLogsDir(), { recursive: true });
      await writeFile(logPath, formatApplyLog(job.sourceRoot, outcomes, now), "utf-8");
      return { outcomes, job: updated, logPath };
    } finally {
      currentApply = null;
    }
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
