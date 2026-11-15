import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeDuplicates, findDuplicates } from "../../src/core/duplicates";
import { scanDirectory } from "../../src/core/scanner";

let root: string;

async function put(relPath: string, content: string | Buffer): Promise<void> {
  const abs = join(root, ...relPath.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function find() {
  const { entries } = await scanDirectory(root);
  return findDuplicates(root, entries);
}

/** Contenuto più lungo della soglia oltre la quale si confronta prima solo l'inizio del file */
function big(fill: string, tail: string): Buffer {
  return Buffer.concat([Buffer.alloc(100 * 1024, fill), Buffer.from(tail)]);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bsys-dup-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("findDuplicates", () => {
  it("raggruppa i file con lo stesso contenuto, anche con nomi diversi", async () => {
    await put("a/relazione.txt", "stesso contenuto");
    await put("b/copia.txt", "stesso contenuto");
    await put("c/altro.txt", "tutt'altra cosa!!");
    const result = await find();
    expect(result.groups).toEqual([{ kind: "file", paths: ["a/relazione.txt", "b/copia.txt"], copies: 2, size: 16, fileCount: 1 }]);
    expect(result.redundantFiles).toBe(1);
    expect(result.recoverableBytes).toBe(16);
  });

  it("non considera uguali due file di pari dimensione ma contenuto diverso", async () => {
    await put("a.txt", "aaaa");
    await put("b.txt", "bbbb");
    expect((await find()).groups).toEqual([]);
  });

  it("distingue i file grandi che differiscono solo dopo l'inizio", async () => {
    await put("uno.bin", big("x", "fine-1"));
    await put("due.bin", big("x", "fine-2"));
    await put("tre.bin", big("x", "fine-1"));
    const result = await find();
    expect(result.groups.map((g) => g.paths)).toEqual([["tre.bin", "uno.bin"]]);
  });

  it("ignora i file vuoti", async () => {
    await put("a/vuoto.txt", "");
    await put("b/vuoto.txt", "");
    const result = await find();
    expect(result.groups).toEqual([]);
    expect(result.redundantFiles).toBe(0);
  });

  it("segnala una cartella copiata come un solo gruppo, senza ripetere i file che contiene", async () => {
    for (const dir of ["Foto", "Vecchio/Foto - Copia"]) {
      await put(`${dir}/mare.jpg`, "immagine del mare");
      await put(`${dir}/2024/monti.jpg`, "immagine dei monti");
    }
    const result = await find();
    expect(result.groups).toEqual([{ kind: "folder", paths: ["Foto", "Vecchio/Foto - Copia"], copies: 2, size: 35, fileCount: 2 }]);
    expect(result.redundantFiles).toBe(2);
    expect(result.recoverableBytes).toBe(35);
  });

  it("non considera identiche due cartelle se una ha un file in più", async () => {
    await put("A/uno.txt", "contenuto uno");
    await put("B/uno.txt", "contenuto uno");
    await put("B/extra.txt", "solo qui");
    const result = await find();
    expect(result.groups.map((g) => g.kind)).toEqual(["file"]);
    expect(result.groups[0].paths).toEqual(["A/uno.txt", "B/uno.txt"]);
  });

  it("tiene il gruppo dei file se una copia sta anche fuori dalle cartelle identiche", async () => {
    await put("A/doc.txt", "documento importante");
    await put("B/doc.txt", "documento importante");
    await put("sparso.txt", "documento importante");
    const result = await find();
    expect(result.groups.find((g) => g.kind === "folder")?.paths).toEqual(["A", "B"]);
    expect(result.groups.find((g) => g.kind === "file")?.paths).toEqual(["A/doc.txt", "B/doc.txt", "sparso.txt"]);
    expect(result.redundantFiles).toBe(2);
  });

  it("segnala i doppioni interni a una cartella anche se la cartella ha una copia identica", async () => {
    for (const dir of ["A", "B"]) {
      await put(`${dir}/x.txt`, "ripetuto due volte");
      await put(`${dir}/y.txt`, "ripetuto due volte");
    }
    const result = await find();
    expect(result.groups.find((g) => g.kind === "file")?.copies).toBe(4);
    expect(result.groups.find((g) => g.kind === "folder")?.paths).toEqual(["A", "B"]);
  });

  it("ordina i gruppi per spazio occupato dalle copie in più", async () => {
    await put("p1.txt", "piccolo");
    await put("p2.txt", "piccolo");
    await put("g1.txt", "molto più grande del primo");
    await put("g2.txt", "molto più grande del primo");
    expect((await find()).groups.map((g) => g.paths[0])).toEqual(["g1.txt", "p1.txt"]);
  });

  it("si interrompe se la ricerca viene annullata", async () => {
    await put("a.txt", "uguale");
    await put("b.txt", "uguale");
    const { entries } = await scanDirectory(root);
    const abort = new AbortController();
    abort.abort();
    await expect(findDuplicates(root, entries, { signal: abort.signal })).rejects.toThrow();
  });

  it("salta un file sparito dopo la scansione e lo riporta fra gli avvisi", async () => {
    await put("a.txt", "uguale");
    await put("b.txt", "uguale");
    const { entries } = await scanDirectory(root);
    await rm(join(root, "b.txt"));
    const result = await findDuplicates(root, entries);
    expect(result.groups).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("analyzeDuplicates", () => {
  it("riassume l'esito e fa avanzare il conteggio fino al totale", async () => {
    await put("a/film.bin", big("f", "uguale"));
    await put("b/film.bin", big("f", "uguale"));
    await put("unico.txt", "senza doppioni");
    const progress: { phase: string; done: number; total: number }[] = [];
    const summary = await analyzeDuplicates(root, { onProgress: (info) => progress.push(info) });
    expect(summary.scannedFiles).toBe(3);
    expect(summary.redundantFiles).toBe(1);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0].kind).toBe("folder");
    expect(summary.unreadable).toBe(0);
    const last = progress[progress.length - 1];
    expect(last.phase).toBe("hash");
    expect(last.done).toBe(last.total);
  });

  it("fallisce se la sorgente non esiste", async () => {
    await expect(analyzeDuplicates(join(root, "assente"))).rejects.toThrow(/Sorgente non leggibile/);
  });
});
