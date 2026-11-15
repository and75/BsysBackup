import type { DeviceStatus, DuplicateProgress, DuplicateSummary, Job, PreviewSummary, ProgressInfo, ReportSummary } from "../core/types";

export interface JobChanges {
  name?: string;
  sourceRoot?: string;
  defaultDestination?: string;
  verifyWithHash?: boolean;
}

export interface BsysApi {
  platform: string;
  selectFolder(): Promise<string | null>;
  listJobs(): Promise<Job[]>;
  createJob(args: { name: string; sourceRoot: string; defaultDestination: string }): Promise<Job>;
  updateJob(args: { jobId: string; changes: JobChanges }): Promise<Job>;
  deleteJob(args: { jobId: string }): Promise<void>;
  setOverride(args: { jobId: string; relativePath: string; destination: string }): Promise<Job>;
  removeOverride(args: { jobId: string; relativePath: string }): Promise<Job>;
  listSubfolders(args: { jobId: string; relativePath: string }): Promise<string[]>;
  checkDevices(args: { jobId: string }): Promise<DeviceStatus>;
  previewJob(args: { jobId: string }): Promise<PreviewSummary>;
  runJob(args: { jobId: string }): Promise<ReportSummary>;
  cancelJob(): Promise<void>;
  findDuplicates(args: { jobId: string }): Promise<DuplicateSummary>;
  cancelDuplicates(): Promise<void>;
  listHistory(): Promise<ReportSummary[]>;
  openReport(args: { reportId: string }): Promise<void>;
  onProgress(callback: (info: ProgressInfo) => void): void;
  onDuplicateProgress(callback: (info: DuplicateProgress) => void): void;
}

declare global {
  interface Window {
    api: BsysApi;
  }
}
