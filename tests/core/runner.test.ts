import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob, setOverride } from "../../src/core/job";
import { previewDiff, runBackup } from "../../src/core/runner";
import type { Job, ProgressInfo } from "../../src/core/types";

// Su Windows la copia passa da Robocopy vero, che ritenta per qualche secondo i file non scrivibili
vi.setConfig({ testTimeout: 60_000 });

let base: string;
let job: Job;
let reportsDir: string;

async function put(relPath: string, content: string): Promise<void> {
  const abs = join(base, relPath);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

async function exists(relPath: string): Promise<boolean> {
  return stat(join(base, relPath)).then(() => true, () => false);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "bsys-"));
  reportsDir = join(base, "reports");
  await put("src/Documenti/fattura.txt", "fattura");
  await put("src/Foto/2024/img.jpg", "foto");
  job = setOverride(
    createJob({ name: "t", sourceRoot: join(base, "src"), defaultDestination: join(base, "dest") }),
    "Foto",
    join(base, "destFoto")
  );
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("runBackup (Robocopy su Windows, copia file-per-file altrove)", () => {
  it("copia ogni file nella sua destinazione mantenendo il percorso relativo", async () => {
    const report = await runBackup(job, { reportsDir });
    expect(report.totalCopied).toBe(2);
    expect(report.totalFailed).toBe(0);
    expect(await readFile(join(base, "dest/Documenti/fattura.txt"), "utf-8")).toBe("fattura");
    expect(await readFile(join(base, "destFoto/Foto/2024/img.jpg"), "utf-8")).toBe("foto");
    expect(await exists("dest/Foto")).toBe(false);
  });

  it("con override annidati manda ogni sottoalbero solo nella propria destinazione", async () => {
    await put("src/Foto/2023/vecchia.jpg", "vecchia");
    const nested = setOverride(job, "Foto/2024", join(base, "destAltro"));

    const report = await runBackup(nested, { reportsDir });
    expect(report.totalCopied).toBe(3);
    expect(report.totalFailed).toBe(0);
    expect(report.warnings).toEqual([]);
    expect(await exists("dest/Documenti/fattura.txt")).toBe(true);
    expect(await exists("destFoto/Foto/2023/vecchia.jpg")).toBe(true);
    expect(await exists("destAltro/Foto/2024/img.jpg")).toBe(true);
    expect(await exists("dest/Foto")).toBe(false);
    expect(await exists("destFoto/Foto/2024")).toBe(false);

    const preview = await previewDiff(nested);
    expect(preview.planned.every((f) => f.action === "unchanged")).toBe(true);
    expect(preview.removedFromSource).toEqual([]);
  });

  it("al secondo giro non trova nulla da copiare", async () => {
    await runBackup(job, { reportsDir });
    const preview = await previewDiff(job);
    expect(preview.planned.every((f) => f.action === "unchanged")).toBe(true);
  });

  it("ricopia un file modificato anche se la dimensione non cambia", async () => {
    await runBackup(job, { reportsDir });
    const src = join(base, "src/Documenti/fattura.txt");
    await writeFile(src, "FATTURA");
    const later = new Date(Date.now() + 60_000);
    await utimes(src, later, later);

    const report = await runBackup(job, { reportsDir });
    expect(report.totalCopied).toBe(1);
    expect(await readFile(join(base, "dest/Documenti/fattura.txt"), "utf-8")).toBe("FATTURA");
  });

  it("segnala come fallito un file che non è stato possibile scrivere, senza lasciare temporanei", async () => {
    await mkdir(join(base, "dest/Documenti/fattura.txt"), { recursive: true });
    const report = await runBackup(job, { reportsDir });
    expect(report.totalFailed).toBe(1);
    expect(report.totalCopied).toBe(1);
    const failed = report.destinations.flatMap((d) => d.failed);
    expect(failed[0].relPath).toBe("Documenti/fattura.txt");
    expect(await readdir(join(base, "dest/Documenti"))).toEqual(["fattura.txt"]);
  });

  it("con l'hash attivo marca i file come verificati", async () => {
    const report = await runBackup(job, { reportsDir, verifyWithHash: true });
    const copied = report.destinations.flatMap((d) => d.copied);
    expect(copied).toHaveLength(2);
    expect(copied.every((f) => f.verified)).toBe(true);
  });

  it("salta, senza fallire, una destinazione che non può essere creata", async () => {
    await put("blocco", "sono un file, non una cartella");
    const blocked = setOverride(job, "Foto", join(base, "blocco", "destFoto"));
    const report = await runBackup(blocked, { reportsDir });
    expect(report.totalCopied).toBe(1);
    expect(report.totalSkippedUnreachable).toBe(1);
  });
});

describe("avanzamento e annullamento", () => {
  it("segnala le tre fasi in ordine e conta ogni file copiato", async () => {
    const events: ProgressInfo[] = [];
    await runBackup(job, { reportsDir, onProgress: (info) => events.push({ ...info }) });

    const phases = events.map((e) => e.phase).filter((p, i, all) => p !== all[i - 1]);
    expect(phases).toEqual(["scan", "copy", "verify"]);
    const lastOf = (phase: string) => events.filter((e) => e.phase === phase).at(-1);
    expect(lastOf("copy")).toMatchObject({ done: 2, total: 2 });
    expect(lastOf("verify")).toMatchObject({ done: 2, total: 2 });
  });

  it("annullato prima della copia non scrive nulla e riporta i file come interrotti, non falliti", async () => {
    const run = new AbortController();
    run.abort();
    const report = await runBackup(job, { reportsDir, signal: run.signal });
    expect(report).toMatchObject({ cancelled: true, totalCopied: 0, totalFailed: 0, totalInterrupted: 2 });
    expect(await exists("dest")).toBe(false);
    expect(await exists("destFoto")).toBe(false);
  });

  it("annullato a metà conserva i file già copiati e riprende gli altri al giro successivo", async () => {
    const run = new AbortController();
    const report = await runBackup(job, {
      reportsDir,
      concurrency: 1,
      signal: run.signal,
      onProgress: (info) => {
        if (info.phase === "copy" && info.done === 1) run.abort();
      },
    });
    expect(report.cancelled).toBe(true);
    expect(report.totalFailed).toBe(0);
    expect(report.totalCopied + report.totalInterrupted).toBe(2);
    // Robocopy può aver già finito entrambi i file quando arriva l'annullamento; la copia file-per-file no
    if (process.platform !== "win32") expect(report.totalInterrupted).toBe(1);

    const resumed = await runBackup(job, { reportsDir });
    expect(resumed).toMatchObject({ cancelled: false, totalCopied: report.totalInterrupted, totalFailed: 0 });
    expect((await previewDiff(job)).planned.every((f) => f.action === "unchanged")).toBe(true);
  });
});

describe("previewDiff", () => {
  it("non crea le cartelle di destinazione", async () => {
    await previewDiff(job);
    expect(await exists("dest")).toBe(false);
    expect(await exists("destFoto")).toBe(false);
  });

  it("fallisce se la sorgente non esiste, invece di trattarla come vuota", async () => {
    await runBackup(job, { reportsDir });
    await rm(join(base, "src"), { recursive: true });
    await expect(previewDiff(job)).rejects.toThrow(/Sorgente non leggibile/);
  });

  it.runIf(process.platform === "win32")("su Windows una cartella rinominata solo nelle maiuscole non genera differenze", async () => {
    await runBackup(job, { reportsDir });
    await rename(join(base, "src/Documenti"), join(base, "src/documenti"));
    const preview = await previewDiff(job);
    expect(preview.planned.every((f) => f.action === "unchanged")).toBe(true);
    expect(preview.removedFromSource).toEqual([]);
  });

  it("ignora i temporanei di una copia interrotta", async () => {
    await runBackup(job, { reportsDir });
    await put("dest/Documenti/altro.txt.bsys-partial", "a metà");
    const preview = await previewDiff(job);
    expect(preview.removedFromSource).toHaveLength(0);
  });
});
