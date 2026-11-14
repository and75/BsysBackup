import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob, deleteJob, listJobs, loadJob, saveJob, setOverride, updateJob } from "../../src/core/job";
import { REPORT_ID_PATTERN, readHistory, reportTextPath } from "../../src/core/report";
import { checkDevices, previewDiff, runBackup, summarizePreview } from "../../src/core/runner";
import type { Job, PlannedFile, PreviewResult } from "../../src/core/types";

let base: string;
let job: Job;
let reportsDir: string;

async function put(relPath: string, content: string): Promise<void> {
  const abs = join(base, relPath);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "bsys-history-"));
  reportsDir = join(base, "reports");
  await put("src/Documenti/fattura.txt", "fattura");
  await put("src/Foto/img.jpg", "foto!");
  job = setOverride(createJob({ name: "t", sourceRoot: join(base, "src"), defaultDestination: join(base, "dest") }), "Foto", join(base, "destFoto"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("storico dei backup", () => {
  it("ogni backup aggiunge un riepilogo, dal più recente, senza gli elenchi dei file", async () => {
    const first = await runBackup(job, { reportsDir });
    await put("src/Documenti/nuova.txt", "x");
    const second = await runBackup(job, { reportsDir });

    const history = await readHistory(reportsDir);
    expect(history.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(history[1]).toMatchObject({ jobName: "t", totalCopied: 2, totalFailed: 0, cancelled: false, removedFromSource: 0 });
    expect(history[1].destinations).toEqual([
      { destinationRoot: join(base, "dest"), reachable: true, copied: 1, failed: 0, skipped: 0 },
      { destinationRoot: join(base, "destFoto"), reachable: true, copied: 1, failed: 0, skipped: 0 },
    ]);
    expect(first.id).toMatch(REPORT_ID_PATTERN);
    expect(await readdir(reportsDir)).toContain(`${first.id}.txt`);
  });

  it("riporta i primi file non copiati con il motivo", async () => {
    await mkdir(join(base, "dest/Documenti/fattura.txt"), { recursive: true });
    await runBackup(job, { reportsDir });
    const [entry] = await readHistory(reportsDir);
    expect(entry.totalFailed).toBe(1);
    expect(entry.failures).toHaveLength(1);
    expect(entry.failures[0].relPath).toBe("Documenti/fattura.txt");
  });

  it("salta una riga illeggibile invece di perdere tutto lo storico", async () => {
    await runBackup(job, { reportsDir });
    await appendFile(join(reportsDir, "history.jsonl"), '{"id": "troncat\n');
    expect(await readHistory(reportsDir)).toHaveLength(1);
  });

  it("è vuoto se non è mai stato eseguito un backup", async () => {
    expect(await readHistory(reportsDir)).toEqual([]);
  });

  it("apre solo report con un identificativo valido", () => {
    expect(() => reportTextPath(reportsDir, "../../segreto")).toThrow();
    expect(reportTextPath(reportsDir, "0d1c2b3a-0000-4000-8000-000000000000_2026-11-14T10-00-00-000Z")).toBe(
      join(reportsDir, "0d1c2b3a-0000-4000-8000-000000000000_2026-11-14T10-00-00-000Z.txt")
    );
  });
});

describe("summarizePreview", () => {
  it("conta nuovi, modificati e invariati e li ripartisce per destinazione", async () => {
    await runBackup(job, { reportsDir });
    await put("src/Documenti/fattura.txt", "fattura modificata");
    await put("src/Foto/nuova.jpg", "12345");
    const summary = summarizePreview(job, await previewDiff(job));

    expect(summary).toMatchObject({ newFiles: 1, modifiedFiles: 1, unchangedFiles: 1, removedFromSource: 0, bytesToCopy: 18 + 5, changedOmitted: 0 });
    expect(summary.destinations).toEqual([
      { destinationRoot: join(base, "dest"), reachable: true, filesToCopy: 1 },
      { destinationRoot: join(base, "destFoto"), reachable: true, filesToCopy: 1 },
    ]);
    expect(summary.changed.map((f) => `${f.action} ${f.relPath}`).sort()).toEqual(["modified Documenti/fattura.txt", "new Foto/nuova.jpg"]);
  });

  it("limita il campione e dice quanti file ha omesso", () => {
    const planned: PlannedFile[] = Array.from({ length: 250 }, (_, i) => ({
      relPath: `f${i}.txt`,
      sourcePath: `/src/f${i}.txt`,
      destinationRoot: job.defaultDestination,
      destPath: `/dest/f${i}.txt`,
      action: "new",
      size: 10,
      mtimeMs: 0,
    }));
    const preview: PreviewResult = { planned, removedFromSource: [], unreachableDestinations: [job.defaultDestination], warnings: [] };
    const summary = summarizePreview(job, preview);
    expect(summary.changed).toHaveLength(200);
    expect(summary.changedOmitted).toBe(50);
    expect(summary.bytesToCopy).toBe(2500);
    expect(summary.destinations[0]).toEqual({ destinationRoot: job.defaultDestination, reachable: false, filesToCopy: 250 });
  });
});

describe("gestione dei backup configurati", () => {
  const jobsDir = () => join(base, "jobs");

  it("modifica nome, cartelle e opzione hash senza toccare gli override", () => {
    const updated = updateJob(job, { name: "  Nuovo nome ", defaultDestination: "/altro", verifyWithHash: true });
    expect(updated).toMatchObject({ name: "Nuovo nome", defaultDestination: "/altro", verifyWithHash: true, sourceRoot: job.sourceRoot });
    expect(updated.overrides).toEqual(job.overrides);
    expect(() => updateJob(job, { name: "   " })).toThrow();
  });

  it("elenca i backup in ordine di nome ignorando i file estranei", async () => {
    await saveJob(jobsDir(), updateJob(job, { name: "Zeta" }));
    await saveJob(jobsDir(), createJob({ name: "Alfa", sourceRoot: "/a", defaultDestination: "/b" }));
    await writeFile(join(jobsDir(), "appunti.json"), "non è un backup");
    expect((await listJobs(jobsDir())).map((j) => j.name)).toEqual(["Alfa", "Zeta"]);
  });

  it("elimina solo la configurazione", async () => {
    await runBackup(job, { reportsDir });
    await saveJob(jobsDir(), job);
    await deleteJob(jobsDir(), job.id);
    expect(await listJobs(jobsDir())).toEqual([]);
    expect(await readdir(join(base, "dest/Documenti"))).toEqual(["fattura.txt"]);
    expect(await readHistory(reportsDir)).toHaveLength(1);
  });

  it("rifiuta un identificativo che non è quello di un backup", async () => {
    await expect(loadJob(jobsDir(), "../../etc/passwd")).rejects.toThrow(/non valido/);
    await expect(deleteJob(jobsDir(), "..")).rejects.toThrow(/non valido/);
  });
});

describe("checkDevices (controllo dei dispositivi prima dell'analisi)", () => {
  it("considera collegata una destinazione non ancora creata su un disco presente", async () => {
    expect(await checkDevices(job)).toEqual({ sourceConnected: true, missingDestinations: [] });
  });

  it("segnala la sorgente assente", async () => {
    const moved = updateJob(job, { sourceRoot: join(base, "non-esiste") });
    expect((await checkDevices(moved)).sourceConnected).toBe(false);
  });

  it.runIf(process.platform === "win32")("su Windows segnala i dischi di destinazione non collegati", async () => {
    const away = setOverride(updateJob(job, { defaultDestination: "Q:\\Backup" }), "Foto", "R:\\Foto");
    expect(await checkDevices(away)).toEqual({ sourceConnected: true, missingDestinations: ["Q:\\Backup", "R:\\Foto"] });
  });
});
