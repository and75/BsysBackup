import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { createJob, loadJob, removeOverride, saveJob, setOverride } from "../core/job";
import { previewDiff, runBackup } from "../core/runner";
import type { Job } from "../core/types";

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

  ipcMain.handle("job:listSubfolders", async (_e, args: { absolutePath: string }) => {
    try {
      const entries = await readdir(args.absolutePath, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  });

  ipcMain.handle("job:preview", async (_e, args: { jobId: string }) => {
    const job = await loadJob(userDataSubdir("jobs"), args.jobId);
    return previewDiff(job);
  });

  ipcMain.handle("job:run", async (event, args: { jobId: string }) => {
    const job = await loadJob(userDataSubdir("jobs"), args.jobId);
    return runBackup(job, {
      reportsDir: userDataSubdir("reports"),
      onProgress: (info) => event.sender.send("job:progress", info),
    });
  });
}
