import type { Job, PlannedFile, BackupReport } from "../core/types";

export interface PreviewResult {
  planned: PlannedFile[];
  removedFromSource: PlannedFile[];
  unreachableDestinations: string[];
}

export interface BsysApi {
  selectFolder(): Promise<string | null>;
  listJobs(): Promise<Job[]>;
  createJob(args: { name: string; sourceRoot: string; defaultDestination: string }): Promise<Job>;
  setOverride(args: { jobId: string; relativePath: string; destination: string }): Promise<Job>;
  removeOverride(args: { jobId: string; relativePath: string }): Promise<Job>;
  listSubfolders(args: { absolutePath: string }): Promise<string[]>;
  previewJob(args: { jobId: string }): Promise<PreviewResult>;
  runJob(args: { jobId: string }): Promise<BackupReport>;
  onProgress(callback: (info: { relPath: string; done: number; total: number }) => void): void;
}

declare global {
  interface Window {
    api: BsysApi;
  }
}
