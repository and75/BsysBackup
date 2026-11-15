import { stat } from "node:fs/promises";
import type { PlannedFile, CopyResult } from "./types";
import { hashFile } from "./hash";
import { mtimeDiffers } from "./differ";

/**
 * Verifica che un file copiato sia davvero presente e aggiornato in destinazione.
 * Sempre: dimensione e data di modifica uguali alla sorgente (senza il controllo sulla data,
 * una copia fallita di un file modificato ma di pari dimensione passerebbe per riuscita).
 * Con `useHash`: anche SHA-256 identico. `knownSourceHash` evita di rileggere la sorgente
 * quando l'hash è già stato calcolato durante la copia.
 */
export async function verifyCopiedFile(
  file: PlannedFile,
  opts: { useHash: boolean; knownSourceHash?: string }
): Promise<CopyResult> {
  const fail = (error: string): CopyResult => ({ relPath: file.relPath, destPath: file.destPath, ok: false, verified: false, error });

  try {
    const destStat = await stat(file.destPath);
    if (destStat.size !== file.size) return fail("dimensione diversa dalla sorgente dopo la copia");
    if (mtimeDiffers(destStat.mtimeMs, file.mtimeMs)) return fail("data di modifica diversa dalla sorgente dopo la copia");

    if (opts.useHash) {
      const sourceHash = opts.knownSourceHash ?? (await hashFile(file.sourcePath));
      const destHash = await hashFile(file.destPath);
      if (destHash !== sourceHash) return fail("hash diverso dalla sorgente dopo la copia");
    }

    return { relPath: file.relPath, destPath: file.destPath, ok: true, verified: opts.useHash };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return fail(e?.code === "ENOENT" ? "file assente in destinazione dopo la copia" : String(e?.message ?? err));
  }
}

/** Controllo rapido (solo size+mtime, senza hash, senza messaggi d'errore): usato per l'avanzamento durante la copia */
export async function quickCheck(file: PlannedFile): Promise<boolean> {
  try {
    const destStat = await stat(file.destPath);
    return destStat.size === file.size && !mtimeDiffers(destStat.mtimeMs, file.mtimeMs);
  } catch {
    return false;
  }
}

export interface VerifyManyOptions {
  useHash: boolean;
  concurrency: number;
  knownSourceHashes?: Map<string, string>;
  onFile?: (file: PlannedFile, result: CopyResult) => void;
}

/**
 * Verifica molti file in parallelo. Il solo controllo di dimensione e data ammette una
 * concorrenza alta; con l'hash si rilegge il contenuto due volte per file, quindi se ne
 * fanno meno insieme per non competere troppo con un disco esterno lento.
 */
export async function verifyPlannedFiles(files: PlannedFile[], opts: VerifyManyOptions): Promise<Map<string, CopyResult>> {
  const results = new Map<string, CopyResult>();
  let index = 0;

  async function worker(): Promise<void> {
    while (index < files.length) {
      const file = files[index++];
      const result = await verifyCopiedFile(file, { useHash: opts.useHash, knownSourceHash: opts.knownSourceHashes?.get(file.relPath) });
      results.set(file.relPath, result);
      opts.onFile?.(file, result);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => worker()));
  return results;
}
