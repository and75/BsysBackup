import type { FileEntry, Job, PlannedFile } from "./types";
import { isExcluded, pathKey, resolveDestinationRoot, toAbs } from "./router";

export interface DiffResult {
  /** File da copiare (nuovi o modificati) o già uguali (unchanged, utile per il report) */
  planned: PlannedFile[];
  /** File presenti in una destinazione ma non più nella sorgente (solo per la parte di albero di competenza di quella destinazione) */
  removedFromSource: PlannedFile[];
}

/**
 * Tolleranza nel confronto dei timestamp: necessaria perché molti dischi esterni USB sono
 * formattati FAT32/exFAT, che arrotonda mtime a 2 secondi (lo stesso motivo per cui rsync
 * usa --modify-window). Senza questa tolleranza ogni file verrebbe rilevato come "modified"
 * ad ogni run anche senza alcuna modifica reale.
 */
const MTIME_TOLERANCE_MS = 2000;

export function mtimeDiffers(a: number, b: number): boolean {
  return Math.abs(a - b) > MTIME_TOLERANCE_MS;
}

/**
 * Confronta la sorgente con una o più destinazioni (già scansionate) e produce il piano.
 * `destEntriesByRoot`: mappa destinationRoot -> elenco file già presenti in quella destinazione.
 */
export function buildDiff(
  job: Job,
  sourceEntries: FileEntry[],
  destEntriesByRoot: Map<string, FileEntry[]>
): DiffResult {
  const planned: PlannedFile[] = [];
  const removedFromSource: PlannedFile[] = [];

  // Indice per lookup rapido: destinationRoot -> relPath -> FileEntry
  const destIndex = new Map<string, Map<string, FileEntry>>();
  for (const [root, entries] of destEntriesByRoot) {
    const m = new Map<string, FileEntry>();
    for (const e of entries) m.set(pathKey(e.relPath), e);
    destIndex.set(root, m);
  }

  for (const src of sourceEntries) {
    const destRoot = resolveDestinationRoot(job, src.relPath);
    const destMap = destIndex.get(destRoot);
    const existing = destMap?.get(pathKey(src.relPath));

    let action: PlannedFile["action"];
    if (!existing) {
      action = "new";
    } else if (existing.size !== src.size || mtimeDiffers(existing.mtimeMs, src.mtimeMs)) {
      action = "modified";
    } else {
      action = "unchanged";
    }

    planned.push({
      relPath: src.relPath,
      sourcePath: toAbs(job.sourceRoot, src.relPath),
      destinationRoot: destRoot,
      destPath: toAbs(destRoot, src.relPath),
      action,
      size: src.size,
      mtimeMs: src.mtimeMs,
    });
  }

  // File rimossi dalla sorgente: solo per i relPath che, se esistessero nella sorgente,
  // sarebbero instradati verso questa stessa destinazione (evita falsi positivi quando
  // una destinazione contiene ancora dati "orfani" di un override cambiato).
  const sourceSet = new Set(sourceEntries.map((e) => pathKey(e.relPath)));
  for (const [root, entries] of destEntriesByRoot) {
    for (const e of entries) {
      if (sourceSet.has(pathKey(e.relPath))) continue;
      // escluso di proposito: non è "rimosso dalla sorgente", è ancora lì, semplicemente non gestito
      if (isExcluded(job, e.relPath)) continue;
      if (resolveDestinationRoot(job, e.relPath) !== root) continue;
      removedFromSource.push({
        relPath: e.relPath,
        sourcePath: toAbs(job.sourceRoot, e.relPath),
        destinationRoot: root,
        destPath: toAbs(root, e.relPath),
        action: "removedFromSource",
        size: e.size,
        mtimeMs: e.mtimeMs,
      });
    }
  }

  return { planned, removedFromSource };
}
