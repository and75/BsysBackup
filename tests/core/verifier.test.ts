import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCopiedFile } from "../../src/core/verifier";
import type { PlannedFile } from "../../src/core/types";

let dir: string;
let file: PlannedFile;
const sourceMtime = new Date("2026-01-10T10:00:00Z");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bsys-verify-"));
  const sourcePath = join(dir, "src.txt");
  const destPath = join(dir, "dest.txt");
  await writeFile(sourcePath, "nuovo");
  await writeFile(destPath, "nuovo");
  await utimes(sourcePath, sourceMtime, sourceMtime);
  await utimes(destPath, sourceMtime, sourceMtime);
  file = { relPath: "a.txt", sourcePath, destinationRoot: dir, destPath, action: "modified", size: 5, mtimeMs: sourceMtime.getTime() };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("verifyCopiedFile", () => {
  it("accetta un file con dimensione e data uguali alla sorgente", async () => {
    expect((await verifyCopiedFile(file, { useHash: false })).ok).toBe(true);
  });

  it("rifiuta la vecchia versione rimasta in destinazione, anche se di pari dimensione", async () => {
    const old = new Date("2025-06-01T10:00:00Z");
    await writeFile(file.destPath, "vecch");
    await utimes(file.destPath, old, old);
    const result = await verifyCopiedFile(file, { useHash: false });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/data di modifica/);
  });

  it("con l'hash rileva un contenuto diverso a parità di dimensione e data", async () => {
    await writeFile(file.destPath, "nuovX");
    await utimes(file.destPath, sourceMtime, sourceMtime);
    expect((await verifyCopiedFile(file, { useHash: false })).ok).toBe(true);
    const result = await verifyCopiedFile(file, { useHash: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/hash/);
  });

  it("segnala il file assente", async () => {
    await rm(file.destPath);
    expect((await verifyCopiedFile(file, { useHash: false })).error).toMatch(/assente/);
  });
});
