import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  selectFolder: () => ipcRenderer.invoke("dialog:selectFolder"),
  listJobs: () => ipcRenderer.invoke("job:list"),
  createJob: (args: { name: string; sourceRoot: string; defaultDestination: string }) => ipcRenderer.invoke("job:create", args),
  setOverride: (args: { jobId: string; relativePath: string; destination: string }) => ipcRenderer.invoke("job:setOverride", args),
  removeOverride: (args: { jobId: string; relativePath: string }) => ipcRenderer.invoke("job:removeOverride", args),
  listSubfolders: (args: { jobId: string; relativePath: string }) => ipcRenderer.invoke("job:listSubfolders", args),
  previewJob: (args: { jobId: string }) => ipcRenderer.invoke("job:preview", args),
  runJob: (args: { jobId: string; verifyWithHash: boolean }) => ipcRenderer.invoke("job:run", args),
  onProgress: (callback: (info: { relPath: string; done: number; total: number }) => void) => {
    ipcRenderer.on("job:progress", (_event, info) => callback(info));
  },
});
