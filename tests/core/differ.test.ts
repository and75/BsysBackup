import { afterEach, describe, expect, it } from "vitest";
import { buildDiff } from "../../src/core/differ";
import { setCaseInsensitivePaths } from "../../src/core/router";
import type { FileEntry, Job } from "../../src/core/types";

function job(overrides: Job["overrides"] = [], excludedPaths: Job["excludedPaths"] = []): Job {
  return {
    id: "j1",
    name: "test",
    sourceRoot: "/src",
    defaultDestination: "/default",
    overrides,
    excludedPaths,
    verifyWithHash: false,
  };
}

function entry(relPath: string, size: number, mtimeMs: number): FileEntry {
  return { relPath, size, mtimeMs };
}

describe("buildDiff", () => {
  it("marca come 'new' un file assente in destinazione", () => {
    const j = job();
    const { planned } = buildDiff(j, [entry("a.txt", 10, 1000)], new Map());
    expect(planned).toHaveLength(1);
    expect(planned[0].action).toBe("new");
  });

  it("marca come 'unchanged' un file identico (size+mtime)", () => {
    const j = job();
    const dest = new Map([["/default", [entry("a.txt", 10, 1000)]]]);
    const { planned } = buildDiff(j, [entry("a.txt", 10, 1000)], dest);
    expect(planned[0].action).toBe("unchanged");
  });

  it("marca come 'modified' un file con size o mtime diversi", () => {
    const j = job();
    const dest = new Map([["/default", [entry("a.txt", 10, 1000)]]]);
    const { planned } = buildDiff(j, [entry("a.txt", 11, 1000)], dest);
    expect(planned[0].action).toBe("modified");
  });

  it("tollera piccole differenze di mtime (es. arrotondamento FAT32/exFAT a 2s)", () => {
    const j = job();
    const dest = new Map([["/default", [entry("a.txt", 10, 1000)]]]);
    const { planned } = buildDiff(j, [entry("a.txt", 10, 1000.9)], dest);
    expect(planned[0].action).toBe("unchanged");
  });

  it("marca come 'modified' se la differenza di mtime supera la tolleranza", () => {
    const j = job();
    const dest = new Map([["/default", [entry("a.txt", 10, 1000)]]]);
    const { planned } = buildDiff(j, [entry("a.txt", 10, 10000)], dest);
    expect(planned[0].action).toBe("modified");
  });

  it("rileva i file rimossi dalla sorgente, solo nella destinazione che li possiede", () => {
    const j = job([{ relativePath: "Foto", destination: "/fotoDest" }]);
    const dest = new Map([
      ["/default", [entry("vecchio.txt", 5, 500)]],
      ["/fotoDest", []],
    ]);
    const { removedFromSource } = buildDiff(j, [], dest);
    expect(removedFromSource).toHaveLength(1);
    expect(removedFromSource[0].relPath).toBe("vecchio.txt");
  });

  it("non segnala come 'rimosso' un file orfano lasciato da un override cambiato", () => {
    // "Foto/x.jpg" è ancora presente in /default (vecchia destinazione) ma ora
    // il routing lo manda a /fotoDest: non deve generare un falso allarme su /default.
    const j = job([{ relativePath: "Foto", destination: "/fotoDest" }]);
    const dest = new Map([
      ["/default", [entry("Foto/x.jpg", 5, 500)]],
      ["/fotoDest", []],
    ]);
    const { removedFromSource } = buildDiff(j, [], dest);
    expect(removedFromSource).toHaveLength(0);
  });

  it("instrada un file verso l'override corretto", () => {
    const j = job([{ relativePath: "Foto", destination: "/fotoDest" }]);
    const { planned } = buildDiff(j, [entry("Foto/img.jpg", 1, 1)], new Map());
    expect(planned[0].destinationRoot).toBe("/fotoDest");
  });
});

describe("buildDiff con cartella rinominata solo nelle maiuscole", () => {
  afterEach(() => setCaseInsensitivePaths(process.platform === "win32"));

  const source = [entry("foto/img.jpg", 5, 1000)];
  const dest = () => new Map([["/default", [entry("Foto/img.jpg", 5, 1000)]]]);

  it("su Windows il file risulta invariato e non compare fra i rimossi", () => {
    setCaseInsensitivePaths(true);
    const { planned, removedFromSource } = buildDiff(job(), source, dest());
    expect(planned.map((f) => f.action)).toEqual(["unchanged"]);
    expect(removedFromSource).toEqual([]);
  });

  it("dove i percorsi distinguono le maiuscole restano due file diversi", () => {
    setCaseInsensitivePaths(false);
    const { planned, removedFromSource } = buildDiff(job(), source, dest());
    expect(planned.map((f) => f.action)).toEqual(["new"]);
    expect(removedFromSource).toHaveLength(1);
  });
});

describe("buildDiff con cartelle o file esclusi", () => {
  // Chi scarta i percorsi esclusi dalla sorgente è lo scanner (vedi runner.test.ts): a buildDiff
  // arrivano già filtrati. Qui si verifica solo che un file escluso ancora presente in
  // destinazione (backup di prima dell'esclusione) non venga segnalato come "rimosso".
  it("un file già nel backup ma ora escluso non risulta 'rimosso dalla sorgente'", () => {
    const j = job([], [{ relativePath: "Foto", isDirectory: true }]);
    const dest = new Map([["/default", [entry("Foto/vecchia.jpg", 5, 500)]]]);
    const { removedFromSource } = buildDiff(j, [], dest);
    expect(removedFromSource).toEqual([]);
  });
});
