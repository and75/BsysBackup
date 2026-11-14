import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { FileEntry } from "./types";

function toRelKey(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/**
 * Attraversa ricorsivamente `root` e produce la lista dei file (no cartelle).
 * Usa withFileTypes per evitare una stat() separata per ogni voce durante il walk.
 */
export async function scanDirectory(root: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  async function walk(dir: string): Promise<void> {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      if (err?.code === "ENOENT") return;
      throw err;
    }

    for (const item of items) {
      const abs = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(abs);
      } else if (item.isFile()) {
        const s = await stat(abs);
        entries.push({
          relPath: toRelKey(root, abs),
          size: s.size,
          mtimeMs: s.mtimeMs,
        });
      }
      // symlink e altri tipi: ignorati deliberatamente per semplicità/sicurezza
    }
  }

  await walk(root);
  return entries;
}

export async function pathReachable(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
