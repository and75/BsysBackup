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

/** File o cartelle con lo stesso identico contenuto, presenti più volte nella sorgente */
export interface DuplicateGroup {
  kind: "file" | "folder";
  /** Percorsi relativi alla sorgente; nel riepilogo possono essere meno di `copies` */
  paths: string[];
  /** Quante volte compare il contenuto */
  copies: number;
  /** Dimensione di una singola copia, in byte */
  size: number;
  /** File contenuti in una copia (1 per un file) */
  fileCount: number;
}

/** Esito della ricerca dei duplicati: conteggi e i gruppi che occupano più spazio */
export interface DuplicateSummary {
  scannedFiles: number;
  /** Copie in più, contando i singoli file: ciò che si potrebbe togliere lasciandone una per contenuto */
  redundantFiles: number;
  /** Spazio occupato dalle copie in più, in byte */
  recoverableBytes: number;
  groups: DuplicateGroup[];
  groupsOmitted: number;
  /** Cartelle o file non leggibili, quindi non confrontati */
  unreadable: number;
}

export interface DuplicateProgress {
  phase: "scan" | "hash";
  /** Byte già confrontati e byte da confrontare */
  done: number;
  total: number;
}

/** Un modello installato in Ollama su questo computer */
export interface AiModel {
  name: string;
  /** Spazio occupato su disco, in byte: è anche, all'incirca, la memoria che serve per usarlo */
  size: number;
  /** Numero di parametri come lo riporta Ollama, es. "9.2B" */
  parameterSize: string;
}

export interface AiStatus {
  /** false se Ollama non risponde su questo computer */
  available: boolean;
  models: AiModel[];
  /** Modello scelto dall'utente o, in mancanza, quello consigliato fra gli installati */
  selected: string | null;
}

export type ReorgAction = "move" | "merge" | "rename" | "removeDuplicate";

/** Una modifica proposta alla sorgente. È solo un suggerimento: l'app non la esegue. */
export interface ReorgProposal {
  action: ReorgAction;
  /** Cartella (o file, per un duplicato) esistente, relativa alla sorgente */
  from: string;
  /** Nuova posizione, cartella in cui confluire, nuovo nome o copia da conservare */
  to: string;
  reason: string;
}

export interface ReorgPlan {
  model: string;
  /** Osservazioni generali del modello sulla struttura */
  summary: string;
  proposals: ReorgProposal[];
  /** Proposte scartate perché indicavano cartelle inesistenti o spostamenti impossibili */
  discarded: number;
  /** true se il modello si è interrotto prima di finire: le proposte possono essere incomplete */
  truncated: boolean;
}

/** Com'è andata l'applicazione di una proposta alla sorgente */
export interface ApplyOutcome {
  proposal: ReorgProposal;
  /** "partial": un'unione in cui alcuni file sono rimasti nella cartella di partenza */
  status: "done" | "partial" | "failed";
  /** Cosa è successo, o perché non è stata applicata */
  detail: string;
  /** true se la cartella (o il file) di partenza non esiste più in quella posizione */
  fromGone: boolean;
}

export interface ApplyResult {
  outcomes: ApplyOutcome[];
  /** Il backup con destinazioni personalizzate ed esclusioni aggiornate ai nuovi percorsi */
  job: Job;
  /** File di testo con l'elenco delle operazioni fatte */
  logPath: string;
}

/** Esito del controllo rapido dei dispositivi di un backup, fatto senza leggere il contenuto delle cartelle */
export interface DeviceStatus {
  sourceConnected: boolean;
  /** Destinazioni il cui disco non è collegato */
  missingDestinations: string[];
}
