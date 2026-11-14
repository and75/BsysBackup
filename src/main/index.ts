import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { createJob, loadJob, removeOverride, saveJob, setOverride } from "../core/job";
import { previewDiff, runBackup } from "../core/runner";
import { toAbs } from "../core/router";
import type { Job, ProgressInfo } from "../core/types";

let currentRun: AbortController | null = null;

function userDataSubdir(name: string): string {
  return join(app.getPath("userData"), name);
}

async function listJobs(): Promise<Job[]> {
  const dir = userDataSubdir("jobs");
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const jobs: Job[] = [];
  for (const n of names) {
    try {
      jobs.push(await loadJob(dir, n.replace(/\.json$/, "")));
    } catch {
      // file corrotto/illeggibile: ignorato
    }
  }
  return jobs;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
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

  ipcMain.handle("job:list", async () => listJobs());

  ipcMain.handle("job:create", async (_e, args: { name: string; sourceRoot: string; defaultDestination: string }) => {
    const job = createJob(args);
    await saveJob(userDataSubdir("jobs"), job);
    return job;
  });

  ipcMain.handle("job:setOverride", async (_e, args: { jobId: string; relativePath: string; destination: string }) => {
    const dir = userDataSubdir("jobs");
    const job = await loadJob(dir, args.jobId);
    const updated = setOverride(job, args.relativePath, args.destination);
    await saveJob(dir, updated);
    return updated;
  });

  ipcMain.handle("job:removeOverride", async (_e, args: { jobId: string; relativePath: string }) => {
    const dir = userDataSubdir("jobs");
    const job = await loadJob(dir, args.jobId);
    const updated = removeOverride(job, args.relativePath);
    await saveJob(dir, updated);
    return updated;
  });

  ipcMain.handle("job:listSubfolders", async (_e, args: { jobId: string; relativePath: string }) => {
    const job = await loadJob(userDataSubdir("jobs"), args.jobId);
    try {
      const entries = await readdir(toAbs(job.sourceRoot, args.relativePath), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  });

  ipcMain.handle("job:preview", async (_e, args: { jobId: string }) => {
    const job = await loadJob(userDataSubdir("jobs"), args.jobId);
    return previewDiff(job);
  });

  ipcMain.handle("job:run", async (event, args: { jobId: string; verifyWithHash: boolean }) => {
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
      const job = await loadJob(userDataSubdir("jobs"), args.jobId);
      return await runBackup(job, {
        reportsDir: userDataSubdir("reports"),
        verifyWithHash: args.verifyWithHash,
        onProgress: sendProgress,
        signal: run.signal,
      });
    } finally {
      currentRun = null;
    }
  });

  ipcMain.handle("job:cancel", () => {
    currentRun?.abort();
  });
}
