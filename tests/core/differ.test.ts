import { describe, expect, it } from "vitest";
import { buildDiff } from "../../src/core/differ";
import type { FileEntry, Job } from "../../src/core/types";

function job(overrides: Job["overrides"] = []): Job {
  return {
    id: "j1",
    name: "test",
    sourceRoot: "/src",
    defaultDestination: "/default",
    overrides,
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
