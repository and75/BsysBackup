import type { DeviceStatus, Job, PreviewSummary, ProgressInfo, ReportSummary } from "../core/types";

export interface JobChanges {
  name?: string;
  sourceRoot?: string;
  defaultDestination?: string;
  verifyWithHash?: boolean;
}

export interface TreeChild {
  name: string;
  isDirectory: boolean;
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
  listChildren(args: { jobId: string; relativePath: string }): Promise<TreeChild[]>;
  excludePath(args: { jobId: string; relativePath: string; isDirectory: boolean }): Promise<Job>;
  includePath(args: { jobId: string; relativePath: string }): Promise<Job>;
  checkDevices(args: { jobId: string }): Promise<DeviceStatus>;
  previewJob(args: { jobId: string }): Promise<PreviewSummary>;
  runJob(args: { jobId: string }): Promise<ReportSummary>;
  cancelJob(): Promise<void>;
  listHistory(): Promise<ReportSummary[]>;
  openReport(args: { reportId: string }): Promise<void>;
  onProgress(callback: (info: ProgressInfo) => void): void;
}

declare global {
  interface Window {
    api: BsysApi;
  }
}
