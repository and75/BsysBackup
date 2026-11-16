import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  platform: process.platform,
  version: process.argv.find((arg) => arg.startsWith("--app-version="))?.slice("--app-version=".length) ?? "",
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
  findDuplicates: (args: unknown) => ipcRenderer.invoke("duplicates:find", args),
  cancelDuplicates: () => ipcRenderer.invoke("duplicates:cancel"),
  aiStatus: () => ipcRenderer.invoke("ai:status"),
  selectAiModel: (args: unknown) => ipcRenderer.invoke("ai:selectModel", args),
  proposeReorganization: (args: unknown) => ipcRenderer.invoke("ai:propose", args),
  cancelProposal: () => ipcRenderer.invoke("ai:cancel"),
  applyPlan: (args: unknown) => ipcRenderer.invoke("reorg:apply", args),
  cancelApply: () => ipcRenderer.invoke("reorg:cancel"),
  openApplyLog: (args: unknown) => ipcRenderer.invoke("reorg:openLog", args),
  listHistory: () => ipcRenderer.invoke("history:list"),
  openReport: (args: unknown) => ipcRenderer.invoke("report:open", args),
  onProgress: (callback: (info: unknown) => void) => {
    ipcRenderer.on("job:progress", (_event, info) => callback(info));
  },
  onApplyProgress: (callback: (info: unknown) => void) => {
    ipcRenderer.on("reorg:progress", (_event, info) => callback(info));
  },
  onProposalProgress: (callback: (chars: number) => void) => {
    ipcRenderer.on("ai:progress", (_event, chars) => callback(chars));
  },
  onDuplicateProgress: (callback: (info: unknown) => void) => {
    ipcRenderer.on("duplicates:progress", (_event, info) => callback(info));
  },
});
