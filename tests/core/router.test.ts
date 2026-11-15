import { afterEach, describe, expect, it } from "vitest";
import { resolveDestinationRoot, resolveRegionPath, buildRegions, computeExcludeRelPaths, planRegionCopies, setCaseInsensitivePaths, isExcluded } from "../../src/core/router";
import { robocopyArgs } from "../../src/core/copier";
import { setOverride } from "../../src/core/job";
import { join } from "node:path";
import type { Job } from "../../src/core/types";

function job(overrides: Job["overrides"], excludedPaths: Job["excludedPaths"] = []): Job {
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
      { relativePath: "", destinationRoot: "/default", sourceDir: "/src", destDir: "/default", excludeDirs: [join("/src", "Foto", "2024")], excludeFiles: [] },
      {
        relativePath: "Foto/2024",
        destinationRoot: "/fotoDest",
        sourceDir: join("/src", "Foto", "2024"),
        destDir: join("/fotoDest", "Foto", "2024"),
        excludeDirs: [],
        excludeFiles: [],
      },
    ]);
  });

  it("passa a Robocopy anche le cartelle e i file esclusi dall'utente, per regione", () => {
    const j = job(
      [{ relativePath: "Foto", destination: "/fotoDest" }],
      [
        { relativePath: "Documenti/Bozze", isDirectory: true },
        { relativePath: "Documenti/appunti.txt", isDirectory: false },
        { relativePath: "Foto/2023", isDirectory: true },
      ]
    );
    const plans = planRegionCopies(j);
    const defaultPlan = plans.find((p) => p.relativePath === "")!;
    expect(defaultPlan.excludeDirs).toEqual(expect.arrayContaining([join("/src", "Foto"), join("/src", "Documenti", "Bozze")]));
    expect(defaultPlan.excludeFiles).toEqual([join("/src", "Documenti", "appunti.txt")]);
    const fotoPlan = plans.find((p) => p.relativePath === "Foto")!;
    expect(fotoPlan.excludeDirs).toEqual([join("/src", "Foto", "2023")]);
    expect(fotoPlan.excludeFiles).toEqual([]);
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

  it("passa a Robocopy la tolleranza FAT, le cartelle da escludere e l'elenco di un file per riga", () => {
    const args = robocopyArgs("C:\\src", "E:\\dest", ["C:\\src\\Foto"]);
    expect(args.slice(0, 2)).toEqual(["C:\\src", "E:\\dest"]);
    expect(args).toEqual(expect.arrayContaining(["/FFT", "/XJ", "/XX", "/NC", "/NS", "/NDL", "/NP", "/NJH", "/NJS"]));
    expect(args).not.toContain("/NFL");
    expect(args.slice(args.indexOf("/XD") + 1)).toEqual(["System Volume Information", "$RECYCLE.BIN", "C:\\src\\Foto"]);
    expect(robocopyArgs("a", "b", [], false)).toContain("/NFL");
  });

  it("aggiunge /XF solo se ci sono file da escludere", () => {
    expect(robocopyArgs("a", "b", [])).not.toContain("/XF");
    const args = robocopyArgs("a", "b", [], true, ["C:\\src\\nota.txt"]);
    expect(args.slice(args.indexOf("/XF") + 1)).toEqual(["C:\\src\\nota.txt"]);
  });
});

describe("isExcluded", () => {
  it("un percorso non escluso è incluso di default", () => {
    expect(isExcluded(job([]), "Documenti/fattura.txt")).toBe(false);
  });

  it("un file escluso direttamente risulta escluso", () => {
    const j = job([], [{ relativePath: "Documenti/appunti.txt", isDirectory: false }]);
    expect(isExcluded(j, "Documenti/appunti.txt")).toBe(true);
    expect(isExcluded(j, "Documenti/fattura.txt")).toBe(false);
  });

  it("escludere una cartella esclude anche tutto il suo contenuto", () => {
    const j = job([], [{ relativePath: "Foto", isDirectory: true }]);
    expect(isExcluded(j, "Foto")).toBe(true);
    expect(isExcluded(j, "Foto/2024/img.jpg")).toBe(true);
    expect(isExcluded(j, "Fotografie/img.jpg")).toBe(false);
  });
});

describe("setOverride", () => {
  it("rifiuta un override sulla cartella principale", () => {
    expect(() => setOverride(job([]), "", "/x")).toThrow();
    expect(() => setOverride(job([]), "/", "/x")).toThrow();
  });
});

describe("percorsi senza distinzione fra maiuscole e minuscole (Windows)", () => {
  afterEach(() => setCaseInsensitivePaths(process.platform === "win32"));

  it("applica l'override anche se la cartella è stata rinominata solo nelle maiuscole", () => {
    const j = job([{ relativePath: "Foto", destination: "/fotoDest" }]);
    setCaseInsensitivePaths(true);
    expect(resolveDestinationRoot(j, "foto/2024/img.jpg")).toBe("/fotoDest");
    expect(resolveDestinationRoot(j, "Fotografie/img.jpg")).toBe("/default");
    setCaseInsensitivePaths(false);
    expect(resolveDestinationRoot(j, "foto/2024/img.jpg")).toBe("/default");
  });

  it("un nuovo override sulla stessa cartella sostituisce quello esistente", () => {
    setCaseInsensitivePaths(true);
    const j = setOverride(job([{ relativePath: "Foto", destination: "/vecchia" }]), "foto", "/nuova");
    expect(j.overrides).toEqual([{ relativePath: "foto", destination: "/nuova" }]);
  });
});
