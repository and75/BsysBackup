import { describe, expect, it } from "vitest";
import { resolveDestinationRoot, resolveRegionPath, buildRegions, computeExcludeRelPaths, planRegionCopies } from "../../src/core/router";
import { robocopyArgs } from "../../src/core/copier";
import { setOverride } from "../../src/core/job";
import { join } from "node:path";
import type { Job } from "../../src/core/types";

function job(overrides: Job["overrides"]): Job {
  return {
    id: "j1",
    name: "test",
    sourceRoot: "/src",
    defaultDestination: "/default",
    overrides,
    verifyWithHash: false,
  };
}

describe("resolveDestinationRoot", () => {
  it("usa la destinazione di default se non ci sono override", () => {
    const j = job([]);
    expect(resolveDestinationRoot(j, "Foto/2024/img.jpg")).toBe("/default");
  });

  it("applica un override su una sottocartella", () => {
    const j = job([{ relativePath: "Foto", destination: "/fotoDest" }]);
    expect(resolveDestinationRoot(j, "Foto/2024/img.jpg")).toBe("/fotoDest");
    expect(resolveDestinationRoot(j, "Documenti/file.txt")).toBe("/default");
  });

  it("l'override più specifico (annidato) vince su quello più generico", () => {
    const j = job([
      { relativePath: "Foto", destination: "/fotoDest" },
      { relativePath: "Foto/2024", destination: "/foto2024Dest" },
    ]);
    expect(resolveDestinationRoot(j, "Foto/2023/img.jpg")).toBe("/fotoDest");
    expect(resolveDestinationRoot(j, "Foto/2024/img.jpg")).toBe("/foto2024Dest");
  });
});

describe("buildRegions / computeExcludeRelPaths", () => {
  it("esclude dalla regione di default le sottocartelle con override", () => {
    const j = job([{ relativePath: "Foto", destination: "/fotoDest" }]);
    const regions = buildRegions(j);
    const defaultRegion = regions.find((r) => r.relativePath === "")!;
    expect(computeExcludeRelPaths(regions, defaultRegion)).toEqual(["Foto"]);
  });

  it("non esclude un override annidato con la stessa destinazione del genitore", () => {
    const j = job([
      { relativePath: "Foto", destination: "/fotoDest" },
      { relativePath: "Foto/2024", destination: "/fotoDest" },
    ]);
    const regions = buildRegions(j);
    const fotoRegion = regions.find((r) => r.relativePath === "Foto")!;
    expect(computeExcludeRelPaths(regions, fotoRegion)).toEqual([]);
  });

  it("esclude un override annidato con destinazione diversa", () => {
    const j = job([
      { relativePath: "Foto", destination: "/fotoDest" },
      { relativePath: "Foto/2024", destination: "/altraDest" },
    ]);
    const regions = buildRegions(j);
    const fotoRegion = regions.find((r) => r.relativePath === "Foto")!;
    expect(computeExcludeRelPaths(regions, fotoRegion)).toEqual(["Foto/2024"]);
  });
});

describe("planRegionCopies (coppie sorgente → destinazione per Robocopy)", () => {
  it("mantiene il percorso relativo dentro la destinazione dell'override, come differ e verifier", () => {
    const j = job([{ relativePath: "Foto/2024", destination: "/fotoDest" }]);
    const plans = planRegionCopies(j);
    expect(plans).toEqual([
      { relativePath: "", destinationRoot: "/default", sourceDir: "/src", destDir: "/default", excludeDirs: [join("/src", "Foto", "2024")] },
      {
        relativePath: "Foto/2024",
        destinationRoot: "/fotoDest",
        sourceDir: join("/src", "Foto", "2024"),
        destDir: join("/fotoDest", "Foto", "2024"),
        excludeDirs: [],
      },
    ]);
  });

  it("assegna ogni file alla regione dell'override più specifico", () => {
    const j = job([
      { relativePath: "Foto", destination: "/fotoDest" },
      { relativePath: "Foto/2024", destination: "/altraDest" },
    ]);
    expect(resolveRegionPath(j, "Documenti/a.txt")).toBe("");
    expect(resolveRegionPath(j, "Foto/2023/a.jpg")).toBe("Foto");
    expect(resolveRegionPath(j, "Foto/2024/a.jpg")).toBe("Foto/2024");
  });

  it("passa a Robocopy la tolleranza FAT e le cartelle da escludere", () => {
    const args = robocopyArgs("C:\\src", "E:\\dest", ["C:\\src\\Foto"]);
    expect(args.slice(0, 2)).toEqual(["C:\\src", "E:\\dest"]);
    expect(args).toContain("/FFT");
    expect(args.slice(args.indexOf("/XD") + 1)).toEqual(["System Volume Information", "$RECYCLE.BIN", "C:\\src\\Foto"]);
  });
});

describe("setOverride", () => {
  it("rifiuta un override sulla cartella principale", () => {
    expect(() => setOverride(job([]), "", "/x")).toThrow();
    expect(() => setOverride(job([]), "/", "/x")).toThrow();
  });
});
