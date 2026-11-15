import { spawn } from "node:child_process";
import { copyFile, mkdir, rename, rm, utimes } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { PlannedFile } from "./types";
import { PARTIAL_SUFFIX, SYSTEM_DIRS } from "./scanner";

export const isWindows = process.platform === "win32";

export async function ensureDir(path: string): Promise<boolean> {
  try {
    await mkdir(path, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export interface RobocopyRunResult {
  ok: boolean;
  cancelled: boolean;
  exitCode: number | null;
  /** Coda dell'output, utile per la diagnosi */
  output: string;
}

export interface RobocopyOptions {
  /** Chiamata per ogni file che Robocopy dichiara di copiare */
  onFile?: () => void;
  /** Annullando il segnale il processo Robocopy viene terminato */
  signal?: AbortSignal;
  /** false = nessuna riga per file (/NFL): serve solo a misurare quanto costa l'elenco */
  listFiles?: boolean;
}

/**
 * Argomenti Robocopy per copiare un sottoalbero. Robocopy confronta già size+timestamp e copia
 * solo le differenze. /FFT usa la stessa tolleranza di 2s del nostro differ (dischi FAT32/exFAT),
 * /XJ non segue le junction, /XD esclude le sottocartelle destinate altrove e quelle di sistema.
 * L'output è ridotto a una riga per file copiato (/NC /NS /NDL /NP /NJH /NJS, /XX per non
 * elencare i file presenti solo in destinazione), così l'avanzamento si ricava contando le righe.
 */
export function robocopyArgs(sourceDir: string, destDir: string, excludeDirs: string[], listFiles = true, excludeFiles: string[] = []): string[] {
  const fileList = listFiles ? ["/NC", "/NS"] : ["/NFL"];
  const args = [
    sourceDir, destDir,
    "/E", "/MT:8", "/FFT", "/XJ", "/R:2", "/W:2",
    "/XX", "/NDL", "/NP", "/NJH", "/NJS", ...fileList,
    "/XD", ...SYSTEM_DIRS, ...excludeDirs,
  ];
  if (excludeFiles.length > 0) args.push("/XF", ...excludeFiles);
  return args;
}

const OUTPUT_TAIL_CHARS = 4000;

/** Exit code Robocopy: 0-7 = successo (con vari dettagli), >=8 = almeno un file non copiato. */
export function runRobocopy(
  sourceDir: string,
  destDir: string,
  excludeDirs: string[] = [],
  excludeFiles: string[] = [],
  opts: RobocopyOptions = {}
): Promise<RobocopyRunResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ ok: false, cancelled: true, exitCode: null, output: "" });
      return;
    }

    const proc = spawn("robocopy", robocopyArgs(sourceDir, destDir, excludeDirs, opts.listFiles ?? true, excludeFiles), { windowsHide: true });
    const onAbort = () => proc.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let output = "";
    let pendingLine = "";
    const countLines = (text: string) => {
      const lines = (pendingLine + text).split(/\r?\n/);
      pendingLine = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) opts.onFile?.();
    };

    proc.stdout?.on("data", (d: Buffer) => {
      const text = d.toString("latin1");
      output = (output + text).slice(-OUTPUT_TAIL_CHARS);
      countLines(text);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      output = (output + d.toString("latin1")).slice(-OUTPUT_TAIL_CHARS);
    });

    const finish = (exitCode: number | null, extra = "") => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (pendingLine.trim()) opts.onFile?.();
      pendingLine = "";
      const cancelled = Boolean(opts.signal?.aborted);
      resolve({ ok: !cancelled && exitCode !== null && exitCode < 8, cancelled, exitCode, output: output + extra });
    };
    proc.on("close", (code) => finish(code));
    proc.on("error", (err) => finish(null, String(err)));
  });
}

export interface CopyOutcome {
  ok: boolean;
  error?: string;
  /** SHA-256 del contenuto letto dalla sorgente, calcolato durante la copia (solo se richiesto) */
  sourceHash?: string;
}

/**
 * Copia file-per-file (piattaforme senza Robocopy) con concorrenza limitata.
 * Ogni file viene scritto su un temporaneo e rinominato solo a copia completata, così
 * un'interruzione non lascia mai in destinazione un file parziale scambiabile per buono.
 */
export async function copyPlannedFiles(
  files: PlannedFile[],
  opts: { concurrency: number; computeHash: boolean; signal?: AbortSignal; onFile?: (relPath: string) => void }
): Promise<Map<string, CopyOutcome>> {
  const results = new Map<string, CopyOutcome>();
  let index = 0;

  // All'annullamento i file già in corso vengono completati; quelli non iniziati restano senza esito
  async function worker(): Promise<void> {
    while (index < files.length && !opts.signal?.aborted) {
      const file = files[index++];
      results.set(file.relPath, await copyOne(file, opts.computeHash));
      opts.onFile?.(file.relPath);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => worker()));
  return results;
}

async function copyOne(file: PlannedFile, computeHash: boolean): Promise<CopyOutcome> {
  const tempPath = file.destPath + PARTIAL_SUFFIX;
  try {
    await mkdir(dirname(file.destPath), { recursive: true });
    let sourceHash: string | undefined;
    if (computeHash) {
      sourceHash = await copyWithHash(file.sourcePath, tempPath);
    } else {
      await copyFile(file.sourcePath, tempPath);
    }
    // mtime uguale alla sorgente: è ciò che rende "unchanged" il file al prossimo confronto
    await utimes(tempPath, new Date(), new Date(file.mtimeMs));
    await rename(tempPath, file.destPath);
    return { ok: true, sourceHash };
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

/** Copia calcolando l'hash nella stessa passata di lettura, per non leggere la sorgente due volte */
async function copyWithHash(sourcePath: string, destPath: string): Promise<string> {
  const hash = createHash("sha256");
  const read = createReadStream(sourcePath);
  read.on("data", (chunk) => hash.update(chunk));
  await pipeline(read, createWriteStream(destPath));
  return hash.digest("hex");
}
