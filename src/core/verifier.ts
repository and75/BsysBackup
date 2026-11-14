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
