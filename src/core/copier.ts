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
  exitCode: number | null;
  output: string;
}

/**
 * Argomenti Robocopy per copiare un sottoalbero. Robocopy confronta già size+timestamp e copia
 * solo le differenze. /FFT usa la stessa tolleranza di 2s del nostro differ (dischi FAT32/exFAT),
 * /XJ non segue le junction, /XD esclude le sottocartelle destinate altrove e quelle di sistema.
 */
export function robocopyArgs(sourceDir: string, destDir: string, excludeDirs: string[]): string[] {
  return [sourceDir, destDir, "/E", "/MT:8", "/FFT", "/XJ", "/R:2", "/W:2", "/NFL", "/NDL", "/NP", "/XD", ...SYSTEM_DIRS, ...excludeDirs];
}

/** Exit code Robocopy: 0-7 = successo (con vari dettagli), >=8 = almeno un file non copiato. */
export function runRobocopy(sourceDir: string, destDir: string, excludeDirs: string[] = []): Promise<RobocopyRunResult> {
  return new Promise((resolve) => {
    const proc = spawn("robocopy", robocopyArgs(sourceDir, destDir, excludeDirs), { windowsHide: true });
    let output = "";
    proc.stdout?.on("data", (d) => (output += d.toString()));
    proc.stderr?.on("data", (d) => (output += d.toString()));
    proc.on("close", (code) => resolve({ ok: code !== null && code < 8, exitCode: code, output }));
    proc.on("error", (err) => resolve({ ok: false, exitCode: null, output: String(err) }));
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
  opts: { concurrency: number; computeHash: boolean }
): Promise<Map<string, CopyOutcome>> {
  const results = new Map<string, CopyOutcome>();
  let index = 0;

  async function worker(): Promise<void> {
    while (index < files.length) {
      const file = files[index++];
      results.set(file.relPath, await copyOne(file, opts.computeHash));
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
