import { readdir, stat } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";
import type { FileEntry } from "./types";

/** Suffisso dei file temporanei scritti dal copiatore: mai trattati come contenuto */
export const PARTIAL_SUFFIX = ".bsys-partial";

/** Cartelle di sistema di Windows presenti nella radice dei dischi, sempre non leggibili */
export const SYSTEM_DIRS = ["System Volume Information", "$RECYCLE.BIN"];

export interface ScanResult {
  entries: FileEntry[];
  /** Cartelle o file che non è stato possibile leggere (permessi, file spariti durante la scansione) */
  skipped: string[];
}

export interface ScanOptions {
  /** true per escludere quel percorso dalla scansione: una cartella esclusa non viene nemmeno attraversata */
  shouldSkip?: (relPath: string, isDirectory: boolean) => boolean;
}

function toRelKey(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function describe(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  return e?.code ?? String(e?.message ?? err);
}

/**
 * Attraversa ricorsivamente `root` e produce la lista dei file (no cartelle, no link).
 * Un errore sulla radice viene propagato; una sottocartella o un file non leggibile
 * viene saltato e riportato in `skipped`, senza interrompere la scansione.
 */
export async function scanDirectory(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const entries: FileEntry[] = [];
  const skipped: string[] = [];
  const { shouldSkip } = options;

  async function walk(dir: string, isRoot: boolean): Promise<void> {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isRoot) throw err;
      skipped.push(`${dir} (${describe(err)})`);
      return;
    }

    for (const item of items) {
      const abs = join(dir, item.name);
      if (item.isDirectory()) {
        if (SYSTEM_DIRS.includes(item.name)) continue;
        if (shouldSkip?.(toRelKey(root, abs), true)) continue;
        await walk(abs, false);
      } else if (item.isFile()) {
        if (item.name.endsWith(PARTIAL_SUFFIX)) continue;
        const relPath = toRelKey(root, abs);
        if (shouldSkip?.(relPath, false)) continue;
        try {
          const s = await stat(abs);
          entries.push({ relPath, size: s.size, mtimeMs: s.mtimeMs });
        } catch (err) {
          skipped.push(`${abs} (${describe(err)})`);
        }
      }
    }
  }

  await walk(root, true);
  return { entries, skipped };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * true se la cartella esiste oppure può essere creata, cioè se esiste almeno la radice
 * del suo disco. Un disco esterno scollegato (es. E:\ assente) risulta non raggiungibile.
 */
export async function isReachable(path: string): Promise<boolean> {
  if (await pathExists(path)) return true;
  return pathExists(parse(resolve(path)).root);
}
