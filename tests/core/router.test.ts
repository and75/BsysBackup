import { describe, expect, it } from "vitest";
import { resolveDestinationRoot, buildRegions, computeExcludeRelPaths } from "../../src/core/router";
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
