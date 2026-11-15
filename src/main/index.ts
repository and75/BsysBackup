import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { createJob, deleteJob, excludePath, includePath, listJobs, loadJob, removeOverride, saveJob, setOverride, updateJob, type JobChanges } from "../core/job";
import { checkDevices, previewDiff, runBackup, summarizePreview } from "../core/runner";
import { readHistory, reportTextPath, toReportSummary } from "../core/report";
import { toAbs } from "../core/router";
import type { ProgressInfo } from "../core/types";

let currentRun: AbortController | null = null;

const jobsDir = () => join(app.getPath("userData"), "jobs");
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
app.on("before-quit", () => currentRun?.abort());

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
    const run = new AbortController();
    currentRun = run;

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

  ipcMain.handle("history:list", () => readHistory(reportsDir(), 20));

  ipcMain.handle("report:open", async (_e, args: { reportId: string }) => {
    const error = await shell.openPath(reportTextPath(reportsDir(), args.reportId));
    if (error) throw new Error(`Impossibile aprire il report: ${error}`);
  });
}
