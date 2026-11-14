import { spawn } from "node:child_process";
import { mkdir, copyFile as fsCopyFile, utimes } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { PlannedFile } from "./types";

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
 * Mirror di un sottoalbero verso una destinazione tramite Robocopy (solo Windows).
 * Robocopy confronta già size+timestamp e copia solo le differenze: /MT parallelizza,
 * /XD esclude le sottocartelle che appartengono a un'altra destinazione (override annidato).
 * Exit code Robocopy: 0-7 = successo (con vari dettagli), >=8 = errore.
 */
export function runRobocopy(sourceDir: string, destDir: string, excludeAbsoluteDirs: string[] = []): Promise<RobocopyRunResult> {
  return new Promise((resolve) => {
    const args = [sourceDir, destDir, "/E", "/MT:8", "/R:2", "/W:2", "/NFL", "/NDL", "/NP"];
    for (const ex of excludeAbsoluteDirs) args.push("/XD", ex);

    const proc = spawn("robocopy", args, { windowsHide: true });
    let output = "";
    proc.stdout?.on("data", (d) => (output += d.toString()));
    proc.stderr?.on("data", (d) => (output += d.toString()));
    proc.on("close", (code) => resolve({ ok: (code ?? 99) < 8, exitCode: code, output }));
    proc.on("error", (err) => resolve({ ok: false, exitCode: null, output: String(err) }));
  });
}

export interface FallbackCopyOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Copia diretta file-per-file (fallback non-Windows / piattaforme senza Robocopy),
 * con concorrenza limitata. L'hash, se richiesto, viene calcolato in singola passata
 * durante la scrittura per non raddoppiare la lettura del file.
 */
export async function copyPlannedFiles(
  files: PlannedFile[],
  opts: { concurrency: number; computeHash: boolean }
): Promise<Map<string, FallbackCopyOutcome & { hash?: string }>> {
  const results = new Map<string, FallbackCopyOutcome & { hash?: string }>();
  let index = 0;

  async function worker(): Promise<void> {
    while (index < files.length) {
      const file = files[index++];
      try {
        await mkdir(dirname(file.destPath), { recursive: true });
        let hash: string | undefined;
        if (opts.computeHash) {
          hash = await copyWithHash(file.sourcePath, file.destPath);
        } else {
          await fsCopyFile(file.sourcePath, file.destPath);
        }
        await utimes(file.destPath, new Date(), new Date(file.mtimeMs)).catch(() => {});
        results.set(file.relPath, { ok: true, hash });
      } catch (err: any) {
        results.set(file.relPath, { ok: false, error: String(err?.message ?? err) });
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, opts.concurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}

function copyWithHash(sourcePath: string, destPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const read = createReadStream(sourcePath);
    const write = createWriteStream(destPath);
    read.on("data", (chunk) => hash.update(chunk));
    read.on("error", reject);
    write.on("error", reject);
    write.on("finish", () => resolve(hash.digest("hex")));
    read.pipe(write);
  });
}
