import type { AiProvider, AiStatus, ApplyResult, DeviceStatus, DuplicateProgress, DuplicateSummary, Job, PreviewSummary, ProgressInfo, ReorgPlan, ReportSummary } from "../core/types";

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
  /** Versione dell'app installata, es. "0.5.0" */
  version: string;
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
  getFilesFolder(): Promise<string | null>;
  setFilesFolder(args: { root: string }): Promise<void>;
  removeDuplicates(args: { root: string; removals: { group: number; path: string }[] }): Promise<ApplyResult>;
  findDuplicates(args: { root: string }): Promise<DuplicateSummary>;
  cancelDuplicates(): Promise<void>;
  aiStatus(): Promise<AiStatus>;
  setAiProvider(args: { provider: AiProvider }): Promise<AiStatus>;
  setAiKey(args: { provider: AiProvider; key: string }): Promise<AiStatus>;
  removeAiKey(args: { provider: AiProvider }): Promise<AiStatus>;
  selectAiModel(args: { model: string }): Promise<void>;
  proposeReorganization(args: { root: string; model: string }): Promise<ReorgPlan>;
  cancelProposal(): Promise<void>;
  applyPlan(args: { root: string; indexes: number[] }): Promise<ApplyResult>;
  cancelApply(): Promise<void>;
  openApplyLog(args: { path: string }): Promise<void>;
  listHistory(): Promise<ReportSummary[]>;
  openReport(args: { reportId: string }): Promise<void>;
  onProgress(callback: (info: ProgressInfo) => void): void;
  onApplyProgress(callback: (info: { done: number; total: number }) => void): void;
  onProposalProgress(callback: (chars: number) => void): void;
  onDuplicateProgress(callback: (info: DuplicateProgress) => void): void;
}

declare global {
  interface Window {
    api: BsysApi;
  }
}
