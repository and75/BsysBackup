import type { Job, BackupReport, PreviewResult, ProgressInfo } from "../core/types";

export interface BsysApi {
  selectFolder(): Promise<string | null>;
  listJobs(): Promise<Job[]>;
  createJob(args: { name: string; sourceRoot: string; defaultDestination: string }): Promise<Job>;
  setOverride(args: { jobId: string; relativePath: string; destination: string }): Promise<Job>;
  removeOverride(args: { jobId: string; relativePath: string }): Promise<Job>;
  listSubfolders(args: { jobId: string; relativePath: string }): Promise<string[]>;
  previewJob(args: { jobId: string }): Promise<PreviewResult>;
  runJob(args: { jobId: string; verifyWithHash: boolean }): Promise<BackupReport>;
  cancelJob(): Promise<void>;
  onProgress(callback: (info: ProgressInfo) => void): void;
}

declare global {
  interface Window {
    api: BsysApi;
  }
}
