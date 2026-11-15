import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  platform: process.platform,
  selectFolder: () => ipcRenderer.invoke("dialog:selectFolder"),
  listJobs: () => ipcRenderer.invoke("job:list"),
  createJob: (args: unknown) => ipcRenderer.invoke("job:create", args),
  updateJob: (args: unknown) => ipcRenderer.invoke("job:update", args),
  deleteJob: (args: unknown) => ipcRenderer.invoke("job:delete", args),
  setOverride: (args: unknown) => ipcRenderer.invoke("job:setOverride", args),
  removeOverride: (args: unknown) => ipcRenderer.invoke("job:removeOverride", args),
  listChildren: (args: unknown) => ipcRenderer.invoke("job:listChildren", args),
  excludePath: (args: unknown) => ipcRenderer.invoke("job:excludePath", args),
  includePath: (args: unknown) => ipcRenderer.invoke("job:includePath", args),
  checkDevices: (args: unknown) => ipcRenderer.invoke("job:devices", args),
  previewJob: (args: unknown) => ipcRenderer.invoke("job:preview", args),
  runJob: (args: unknown) => ipcRenderer.invoke("job:run", args),
  cancelJob: () => ipcRenderer.invoke("job:cancel"),
  listHistory: () => ipcRenderer.invoke("history:list"),
  openReport: (args: unknown) => ipcRenderer.invoke("report:open", args),
  onProgress: (callback: (info: unknown) => void) => {
    ipcRenderer.on("job:progress", (_event, info) => callback(info));
  },
});
