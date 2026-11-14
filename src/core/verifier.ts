import { stat } from "node:fs/promises";
import type { PlannedFile, CopyResult } from "./types";
import { hashFile } from "./hash";

/**
 * Verifica che un file copiato sia effettivamente presente e corretto in destinazione.
 * Default: controllo size (rapido, sempre fatto). Se `useHash`, confronta anche SHA-256
 * sorgente/destinazione per la certezza assoluta (più lento, su richiesta esplicita).
 */
export async function verifyCopiedFile(
  file: PlannedFile,
  opts: { useHash: boolean; precomputedDestHash?: string }
): Promise<CopyResult> {
  try {
    const destStat = await stat(file.destPath);
    if (destStat.size !== file.size) {
      return { relPath: file.relPath, destPath: file.destPath, ok: false, verified: false, error: "dimensione diversa dopo la copia" };
    }

    if (opts.useHash) {
      const [destHash, srcHash] = await Promise.all([
        opts.precomputedDestHash ? Promise.resolve(opts.precomputedDestHash) : hashFile(file.destPath),
        hashFile(file.sourcePath),
      ]);
      if (destHash !== srcHash) {
        return { relPath: file.relPath, destPath: file.destPath, ok: false, verified: false, error: "hash diverso dopo la copia" };
      }
      return { relPath: file.relPath, destPath: file.destPath, ok: true, verified: true };
    }

    return { relPath: file.relPath, destPath: file.destPath, ok: true, verified: false };
  } catch (err: any) {
    return { relPath: file.relPath, destPath: file.destPath, ok: false, verified: false, error: String(err?.message ?? err) };
  }
}
