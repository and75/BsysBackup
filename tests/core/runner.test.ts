import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob, setOverride } from "../../src/core/job";
import { previewDiff, runBackup } from "../../src/core/runner";
import type { Job } from "../../src/core/types";

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

describe("runBackup (copia file-per-file)", () => {
  it("copia ogni file nella sua destinazione mantenendo il percorso relativo", async () => {
    const report = await runBackup(job, { reportsDir });
    expect(report.totalCopied).toBe(2);
    expect(report.totalFailed).toBe(0);
    expect(await readFile(join(base, "dest/Documenti/fattura.txt"), "utf-8")).toBe("fattura");
    expect(await readFile(join(base, "destFoto/Foto/2024/img.jpg"), "utf-8")).toBe("foto");
    expect(await exists("dest/Foto")).toBe(false);
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

  it("ignora i temporanei di una copia interrotta", async () => {
    await runBackup(job, { reportsDir });
    await put("dest/Documenti/altro.txt.bsys-partial", "a metà");
    const preview = await previewDiff(job);
    expect(preview.removedFromSource).toHaveLength(0);
  });
});
