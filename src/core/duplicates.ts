import { createHash } from "node:crypto";
import { hashFile, hashHead } from "./hash";
import { toAbs } from "./router";
import { scanDirectory } from "./scanner";
import type { DuplicateGroup, DuplicateProgress, DuplicateSummary, FileEntry } from "./types";

/** Dei file più grandi di così si confronta prima solo l'inizio, e si leggono per intero solo quelli che coincidono */
const HEAD_BYTES = 64 * 1024;
const HASH_CONCURRENCY = 4;
/** I file vuoti sono tutti uguali: non vengono letti né segnalati, ma contano nel confronto fra cartelle */
const EMPTY_HASH = "empty";

const SUMMARY_GROUPS = 100;
const SUMMARY_PATHS = 20;

export interface DuplicateOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface DuplicateResult {
  /** Gruppi ordinati per spazio occupato dalle copie in più, dal maggiore */
  groups: DuplicateGroup[];
  redundantFiles: number;
  recoverableBytes: number;
  /** File che non è stato possibile leggere */
  warnings: string[];
}

interface DirNode {
  files: { name: string; entry: FileEntry }[];
  dirs: Map<string, DirNode>;
}

interface FolderInfo {
  /** Firma del contenuto, null se la cartella contiene almeno un file che non ha uguali altrove */
  signature: string | null;
  size: number;
  fileCount: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parentOf(relPath: string): string {
  const cut = relPath.lastIndexOf("/");
  return cut === -1 ? "" : relPath.slice(0, cut);
}

function wasted(group: DuplicateGroup): number {
  return (group.copies - 1) * group.size;
}

async function pool<T>(items: T[], signal: AbortSignal | undefined, task: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      signal?.throwIfAborted();
      await task(items[index++]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, items.length) }, () => worker()));
}

/**
 * Calcola l'hash dei soli file che possono avere un doppione: quelli che condividono la dimensione
 * con un altro file e, se grandi, anche l'inizio del contenuto. Gli altri non vengono letti.
 */
async function hashCandidates(root: string, entries: FileEntry[], opts: DuplicateOptions, warnings: string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const sizeCount = new Map<number, number>();
  for (const entry of entries) {
    if (entry.size === 0) hashes.set(entry.relPath, EMPTY_HASH);
    else sizeCount.set(entry.size, (sizeCount.get(entry.size) ?? 0) + 1);
  }
  const candidates = entries.filter((e) => (sizeCount.get(e.size) ?? 0) > 1);

  const total = candidates.reduce((sum, e) => sum + e.size, 0);
  let done = 0;
  const advance = (bytes: number) => {
    done += bytes;
    opts.onProgress?.(done, total);
  };
  const unreadable = (entry: FileEntry, err: unknown) => {
    if (opts.signal?.aborted) throw err;
    warnings.push(`${entry.relPath} (${(err as NodeJS.ErrnoException)?.code ?? String(err)})`);
    advance(entry.size);
  };
  opts.onProgress?.(0, total);

  const heads = new Map<FileEntry, string>();
  await pool(
    candidates.filter((e) => e.size > HEAD_BYTES),
    opts.signal,
    async (entry) => {
      try {
        heads.set(entry, `${entry.size}:${await hashHead(toAbs(root, entry.relPath), HEAD_BYTES)}`);
      } catch (err) {
        unreadable(entry, err);
      }
    }
  );
  const headCount = new Map<string, number>();
  for (const key of heads.values()) headCount.set(key, (headCount.get(key) ?? 0) + 1);

  const toHash: FileEntry[] = [];
  for (const entry of candidates) {
    const head = heads.get(entry);
    if (entry.size <= HEAD_BYTES || (head !== undefined && (headCount.get(head) ?? 0) > 1)) toHash.push(entry);
    else if (head !== undefined) advance(entry.size);
  }

  await pool(toHash, opts.signal, async (entry) => {
    try {
      hashes.set(entry.relPath, await hashFile(toAbs(root, entry.relPath), opts.signal));
      advance(entry.size);
    } catch (err) {
      unreadable(entry, err);
    }
  });
  return hashes;
}

function buildTree(entries: FileEntry[]): DirNode {
  const root: DirNode = { files: [], dirs: new Map() };
  for (const entry of entries) {
    const parts = entry.relPath.split("/");
    const name = parts.pop() as string;
    let node = root;
    for (const part of parts) {
      let child = node.dirs.get(part);
      if (!child) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ name, entry });
  }
  return root;
}

/** Firma ogni cartella dai nomi e dagli hash di ciò che contiene: due cartelle con la stessa firma sono copie identiche */
function signFolders(node: DirNode, relPath: string, hashes: Map<string, string>, out: Map<string, FolderInfo>): FolderInfo {
  const parts: string[] = [];
  let comparable = true;
  let size = 0;
  let fileCount = 0;

  for (const { name, entry } of node.files) {
    const hash = hashes.get(entry.relPath);
    if (hash === undefined) comparable = false;
    else parts.push(`f\0${name}\0${hash}`);
    size += entry.size;
    fileCount++;
  }
  for (const [name, child] of node.dirs) {
    const info = signFolders(child, relPath ? `${relPath}/${name}` : name, hashes, out);
    if (info.signature === null) comparable = false;
    else parts.push(`d\0${name}\0${info.signature}`);
    size += info.size;
    fileCount += info.fileCount;
  }

  const info: FolderInfo = { signature: comparable ? sha256(parts.sort().join("\n")) : null, size, fileCount };
  out.set(relPath, info);
  return info;
}

/**
 * Trova i file e le cartelle con lo stesso contenuto fra quelli elencati da una scansione di `root`.
 * Ciò che sta dentro due cartelle identiche non viene ripetuto: basta il gruppo delle cartelle.
 */
export async function findDuplicates(root: string, entries: FileEntry[], opts: DuplicateOptions = {}): Promise<DuplicateResult> {
  const warnings: string[] = [];
  const hashes = await hashCandidates(root, entries, opts, warnings);

  const folders = new Map<string, FolderInfo>();
  signFolders(buildTree(entries), "", hashes, folders);

  /** true se le copie stanno, una per una, dentro cartelle a loro volta identiche fra loro */
  const impliedByParents = (paths: string[]): boolean => {
    const parents = paths.map(parentOf);
    const signature = folders.get(parents[0])?.signature;
    return (
      typeof signature === "string" &&
      new Set(parents).size === parents.length &&
      parents.every((p) => p !== "" && folders.get(p)?.signature === signature)
    );
  };

  const groups: DuplicateGroup[] = [];
  let redundantFiles = 0;
  let recoverableBytes = 0;

  const byContent = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const hash = hashes.get(entry.relPath);
    if (entry.size === 0 || hash === undefined) continue;
    const key = `${entry.size}:${hash}`;
    const same = byContent.get(key);
    if (same) same.push(entry);
    else byContent.set(key, [entry]);
  }
  for (const same of byContent.values()) {
    if (same.length < 2) continue;
    redundantFiles += same.length - 1;
    recoverableBytes += (same.length - 1) * same[0].size;
    const paths = same.map((e) => e.relPath).sort();
    if (!impliedByParents(paths)) groups.push({ kind: "file", paths, copies: paths.length, size: same[0].size, fileCount: 1 });
  }

  const bySignature = new Map<string, string[]>();
  for (const [relPath, info] of folders) {
    if (relPath === "" || info.signature === null || info.size === 0) continue;
    const same = bySignature.get(info.signature);
    if (same) same.push(relPath);
    else bySignature.set(info.signature, [relPath]);
  }
  for (const same of bySignature.values()) {
    if (same.length < 2) continue;
    const paths = same.sort();
    const info = folders.get(paths[0]) as FolderInfo;
    if (!impliedByParents(paths)) groups.push({ kind: "folder", paths, copies: paths.length, size: info.size, fileCount: info.fileCount });
  }

  groups.sort((a, b) => wasted(b) - wasted(a) || a.paths[0].localeCompare(b.paths[0]));
  return { groups, redundantFiles, recoverableBytes, warnings };
}

/** Ciò che una ricerca ha letto della sorgente: serve anche a chi propone una riorganizzazione */
export interface SourceAnalysis {
  sourceRoot: string;
  entries: FileEntry[];
  duplicates: DuplicateResult;
  /** false se i duplicati non sono stati cercati: `duplicates` è vuoto perché non si sa, non perché non ce ne sono */
  duplicatesKnown: boolean;
  /** Cartelle o file non leggibili durante la scansione */
  skipped: string[];
}

/** Scansiona la sorgente e ne cerca i duplicati. Legge soltanto: non sposta né cancella nulla. */
export async function analyzeSource(
  sourceRoot: string,
  opts: {
    signal?: AbortSignal;
    onProgress?: (info: DuplicateProgress) => void;
    /** true per lasciare fuori dalla ricerca quel percorso, come le cartelle escluse dal backup */
    shouldSkip?: (relPath: string, isDirectory: boolean) => boolean;
  } = {}
): Promise<SourceAnalysis> {
  opts.onProgress?.({ phase: "scan", done: 0, total: 0 });
  let scan;
  try {
    scan = await scanDirectory(sourceRoot, { shouldSkip: opts.shouldSkip });
  } catch (err) {
    throw new Error(`Sorgente non leggibile: ${sourceRoot} (${(err as Error).message})`);
  }
  opts.signal?.throwIfAborted();

  const duplicates = await findDuplicates(sourceRoot, scan.entries, {
    signal: opts.signal,
    onProgress: (done, total) => opts.onProgress?.({ phase: "hash", done, total }),
  });
  return { sourceRoot, entries: scan.entries, duplicates, duplicatesKnown: true, skipped: scan.skipped };
}

/**
 * Legge solo l'elenco dei file della sorgente, senza cercare i duplicati: è questione di secondi,
 * perché non apre nessun file. Basta a chi vuole una proposta di riorganizzazione senza aspettare la ricerca.
 */
export async function listSource(sourceRoot: string, shouldSkip?: (relPath: string, isDirectory: boolean) => boolean): Promise<SourceAnalysis> {
  let scan;
  try {
    scan = await scanDirectory(sourceRoot, { shouldSkip });
  } catch (err) {
    throw new Error(`Sorgente non leggibile: ${sourceRoot} (${(err as Error).message})`);
  }
  const duplicates: DuplicateResult = { groups: [], redundantFiles: 0, recoverableBytes: 0, warnings: [] };
  return { sourceRoot, entries: scan.entries, duplicates, duplicatesKnown: false, skipped: scan.skipped };
}

/** Riepilogo per l'interfaccia: conteggi e i gruppi più pesanti, senza l'elenco completo */
export function summarizeDuplicates(analysis: SourceAnalysis): DuplicateSummary {
  const { groups, redundantFiles, recoverableBytes, warnings } = analysis.duplicates;
  return {
    scannedFiles: analysis.entries.length,
    redundantFiles,
    recoverableBytes,
    groups: groups.slice(0, SUMMARY_GROUPS).map((g) => ({ ...g, paths: g.paths.slice(0, SUMMARY_PATHS) })),
    groupsOmitted: Math.max(0, groups.length - SUMMARY_GROUPS),
    unreadable: analysis.skipped.length + warnings.length,
  };
}
