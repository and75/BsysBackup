import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJob, excludePath, includePath, setOverride } from "../../src/core/job";
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
  base = await mkdtemp(join(tmpdir(), "bsys-exclude-"));
  reportsDir = join(base, "reports");
  await put("src/Documenti/fattura.txt", "fattura");
  await put("src/Documenti/appunti.txt", "appunti personali");
  await put("src/Foto/2023/vecchia.jpg", "vecchia");
  await put("src/Foto/2024/nuova.jpg", "nuova");
  job = createJob({ name: "t", sourceRoot: join(base, "src"), defaultDestination: join(base, "dest") });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("job.excludePath / includePath", () => {
  it("rifiuta di escludere l'intera cartella sorgente", () => {
    expect(() => excludePath(job, "", true)).toThrow();
  });

  it("non duplica un'esclusione già presente", () => {
    const j = excludePath(excludePath(job, "Foto", true), "Foto", true);
    expect(j.excludedPaths).toHaveLength(1);
  });

  it("includePath rimuove solo l'esclusione diretta su quel percorso esatto", () => {
    const withBoth = excludePath(excludePath(job, "Foto", true), "Documenti/appunti.txt", false);
    const j = includePath(withBoth, "Foto");
    expect(j.excludedPaths).toEqual([{ relativePath: "Documenti/appunti.txt", isDirectory: false }]);
  });
});

describe("una cartella esclusa", () => {
  it("non viene copiata, e i suoi file non compaiono nell'anteprima", async () => {
    const j = excludePath(job, "Foto", true);
    const preview = await previewDiff(j);
    expect(preview.planned.map((f) => f.relPath)).toEqual(["Documenti/appunti.txt", "Documenti/fattura.txt"]);

    const report = await runBackup(j, { reportsDir });
    expect(report.totalCopied).toBe(2);
    expect(await exists("dest/Documenti")).toBe(true);
    expect(await exists("dest/Foto")).toBe(false);
  });

  it("se era già stata salvata prima dell'esclusione, non risulta 'rimossa dalla sorgente'", async () => {
    await runBackup(job, { reportsDir });
    const j = excludePath(job, "Foto", true);
    const preview = await previewDiff(j);
    expect(preview.removedFromSource).toEqual([]);
    // i file già copiati restano dove sono: un'esclusione non cancella nulla
    expect(await exists("dest/Foto/2023/vecchia.jpg")).toBe(true);
  });

  it("esclude anche dentro un override: solo il sottoalbero escluso viene saltato", async () => {
    const j = excludePath(setOverride(job, "Foto", join(base, "destFoto")), "Foto/2023", true);
    const report = await runBackup(j, { reportsDir });
    expect(report.totalCopied).toBe(3);
    expect(await exists("destFoto/Foto/2024/nuova.jpg")).toBe(true);
    expect(await exists("destFoto/Foto/2023")).toBe(false);
  });
});

describe("un file escluso dentro una cartella inclusa", () => {
  it("salta solo quel file, non i file vicini", async () => {
    const j = excludePath(job, "Documenti/appunti.txt", false);
    const report = await runBackup(j, { reportsDir });
    expect(report.totalCopied).toBe(3);
    expect(await exists("dest/Documenti/fattura.txt")).toBe(true);
    expect(await exists("dest/Documenti/appunti.txt")).toBe(false);
  });
});
