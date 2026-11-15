export interface FileEntry {
  /** Percorso relativo alla radice (sourceRoot o destinationRoot), separatori '/' normalizzati */
  relPath: string;
  size: number;
  mtimeMs: number;
}

export interface Override {
  /** Percorso relativo alla sourceRoot della sottocartella da reindirizzare */
  relativePath: string;
  /** Cartella di destinazione assoluta per questa sottocartella */
  destination: string;
}

export interface ExcludedPath {
  /** Percorso relativo alla sourceRoot escluso dal backup, con tutto il suo contenuto se è una cartella */
  relativePath: string;
  isDirectory: boolean;
}

export interface Job {
  id: string;
  name: string;
  sourceRoot: string;
  defaultDestination: string;
  overrides: Override[];
  /**
   * Cartelle e file esclusi dal backup. Un'esclusione vale anche per tutto ciò che sta sotto:
   * non è possibile reincludere un file dentro una cartella esclusa (Robocopy, su Windows,
   * specchia intere sottocartelle e non supporta eccezioni annidate dentro una esclusione).
   */
  excludedPaths: ExcludedPath[];
  /** Se true, calcola e verifica l'hash SHA-256 oltre a size+mtime */
  verifyWithHash: boolean;
}

export type FileAction = "new" | "modified" | "unchanged" | "removedFromSource";

export interface PlannedFile {
  relPath: string;
  sourcePath: string;
  destinationRoot: string;
  destPath: string;
  action: FileAction;
  size: number;
  mtimeMs: number;
}

export interface CopyResult {
  relPath: string;
  destPath: string;
  ok: boolean;
  verified: boolean;
  error?: string;
}

export interface DestinationGroupReport {
  destinationRoot: string;
  reachable: boolean;
  copied: CopyResult[];
  failed: CopyResult[];
  skippedUnreachable: PlannedFile[];
}

export interface BackupReport {
  /** Identificativo del report: nome dei file .json/.txt salvati e chiave nello storico */
  id: string;
  jobId: string;
  jobName: string;
  startedAt: string;
  finishedAt: string;
  totalPlanned: number;
  totalCopied: number;
  totalFailed: number;
  totalSkippedUnreachable: number;
  /** true se l'utente ha annullato il backup prima della fine */
  cancelled: boolean;
  /** File non copiati perché il backup è stato annullato: verranno ripresi alla prossima esecuzione */
  totalInterrupted: number;
  removedFromSource: PlannedFile[];
  destinations: DestinationGroupReport[];
  /** Problemi non bloccanti: cartelle non leggibili, errori segnalati da Robocopy, ecc. */
  warnings: string[];
}

export interface PreviewResult {
  planned: PlannedFile[];
  removedFromSource: PlannedFile[];
  unreachableDestinations: string[];
  warnings: string[];
}

export interface ProgressInfo {
  phase: "scan" | "copy" | "verify";
  done: number;
  total: number;
  relPath?: string;
}

export interface DestinationSummary {
  destinationRoot: string;
  reachable: boolean;
  copied: number;
  failed: number;
  skipped: number;
}

/** Riepilogo di un backup concluso: è ciò che finisce nello storico e che l'interfaccia mostra */
export interface ReportSummary {
  id: string;
  jobId: string;
  jobName: string;
  startedAt: string;
  finishedAt: string;
  totalPlanned: number;
  totalCopied: number;
  totalFailed: number;
  totalSkippedUnreachable: number;
  cancelled: boolean;
  totalInterrupted: number;
  removedFromSource: number;
  destinations: DestinationSummary[];
  /** Primi file non copiati; gli altri sono nel report completo */
  failures: { relPath: string; error: string }[];
  failuresOmitted: number;
  warnings: string[];
  warningsOmitted: number;
}

/** Riepilogo di un'anteprima: conteggi e un campione, senza l'elenco completo dei file */
export interface PreviewSummary {
  newFiles: number;
  modifiedFiles: number;
  unchangedFiles: number;
  removedFromSource: number;
  bytesToCopy: number;
  destinations: { destinationRoot: string; reachable: boolean; filesToCopy: number }[];
  changed: { action: "new" | "modified"; relPath: string; destinationRoot: string }[];
  changedOmitted: number;
  warnings: string[];
  warningsOmitted: number;
}

/** Esito del controllo rapido dei dispositivi di un backup, fatto senza leggere il contenuto delle cartelle */
export interface DeviceStatus {
  sourceConnected: boolean;
  /** Destinazioni il cui disco non è collegato */
  missingDestinations: string[];
}
