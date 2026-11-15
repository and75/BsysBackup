import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchCopyProgress } from "../../src/core/runner";
import { verifyPlannedFiles } from "../../src/core/verifier";
import type { PlannedFile } from "../../src/core/types";

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "bsys-progress-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function planned(name: string, size: number, mtimeMs: number): PlannedFile {
  return {
    relPath: name,
    sourcePath: join(base, "src", name),
    destinationRoot: join(base, "dest"),
    destPath: join(base, "dest", name),
    action: "new",
    size,
    mtimeMs,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watchCopyProgress (avanzamento letto dai file, non dall'output di un programma esterno)", () => {
  it("segnala un file come copiato solo quando è presente con la dimensione e la data giuste", async () => {
    const mtime = new Date("2026-01-10T10:00:00Z");
    const files = [planned("a.txt", 5, mtime.getTime()), planned("b.txt", 5, mtime.getTime())];
    const ticks: number[] = [];
    const watcher = watchCopyProgress(files, { intervalMs: 20, concurrency: 4 }, (done) => ticks.push(done));

    await sleep(30);
    expect(ticks.filter((t) => t > 0)).toEqual([]); // nessun file esiste ancora

    await mkdir(join(base, "dest"), { recursive: true });
    await writeFile(join(base, "dest", "a.txt"), "xxxxx");
    await utimes(join(base, "dest", "a.txt"), mtime, mtime);
    await sleep(40);
    expect(ticks.at(-1)).toBe(1);

    await writeFile(join(base, "dest", "b.txt"), "xxxx"); // dimensione sbagliata: non deve contare
    await sleep(40);
    expect(ticks.at(-1)).toBe(1);

    await writeFile(join(base, "dest", "b.txt"), "xxxxx");
    await utimes(join(base, "dest", "b.txt"), mtime, mtime);
    await sleep(40);
    expect(ticks.at(-1)).toBe(2);

    watcher.stop();
  });

  it("smette di controllare dopo stop(), anche se arriva un altro tick in corso", async () => {
    const mtime = new Date("2026-01-10T10:00:00Z");
    const files = [planned("a.txt", 5, mtime.getTime())];
    const ticks: number[] = [];
    const watcher = watchCopyProgress(files, { intervalMs: 15 }, (done) => ticks.push(done));
    watcher.stop();
    await mkdir(join(base, "dest"), { recursive: true });
    await writeFile(join(base, "dest", "a.txt"), "xxxxx");
    await utimes(join(base, "dest", "a.txt"), mtime, mtime);
    await sleep(60);
    expect(ticks).toEqual([]);
  });

  it("si ferma da solo quando il segnale è già annullato", async () => {
    const files = [planned("a.txt", 5, 0)];
    const ticks: number[] = [];
    const controller = new AbortController();
    controller.abort();
    watchCopyProgress(files, { signal: controller.signal, intervalMs: 10 }, (done) => ticks.push(done));
    await sleep(40);
    expect(ticks).toEqual([]);
  });
});

describe("verifyPlannedFiles (verifica in parallelo)", () => {
  it("verifica tutti i file anche se alcuni falliscono, senza fermarsi al primo", async () => {
    const mtime = new Date("2026-01-10T10:00:00Z");
    await mkdir(join(base, "dest"), { recursive: true });
    await mkdir(join(base, "src"), { recursive: true });
    const files: PlannedFile[] = [];
    for (let i = 0; i < 20; i++) {
      const content = "x".repeat(10);
      await writeFile(join(base, "src", `f${i}.txt`), content);
      files.push(planned(`f${i}.txt`, 10, mtime.getTime()));
      if (i % 3 !== 0) {
        await writeFile(join(base, "dest", `f${i}.txt`), content);
        await utimes(join(base, "dest", `f${i}.txt`), mtime, mtime);
      }
      // i file multipli di 3 restano assenti in destinazione: devono risultare falliti
    }

    const results = await verifyPlannedFiles(files, { useHash: false, concurrency: 6 });
    expect(results.size).toBe(20);
    const ok = [...results.values()].filter((r) => r.ok).length;
    expect(ok).toBe(files.length - Math.ceil(files.length / 3));
    expect(results.get("f0.txt")?.error).toMatch(/assente/);
    expect(results.get("f1.txt")?.ok).toBe(true);
  });

  it("con l'hash rileva un contenuto diverso a parità di dimensione e data", async () => {
    await mkdir(join(base, "dest"), { recursive: true });
    await mkdir(join(base, "src"), { recursive: true });
    const mtime = new Date("2026-01-10T10:00:00Z");
    await writeFile(join(base, "src", "a.txt"), "nuovo");
    await writeFile(join(base, "dest", "a.txt"), "NUOVX");
    await utimes(join(base, "src", "a.txt"), mtime, mtime);
    await utimes(join(base, "dest", "a.txt"), mtime, mtime);

    const results = await verifyPlannedFiles([planned("a.txt", 5, mtime.getTime())], { useHash: true, concurrency: 2 });
    expect(results.get("a.txt")?.ok).toBe(false);
    expect(results.get("a.txt")?.error).toMatch(/hash/);
  });
});
