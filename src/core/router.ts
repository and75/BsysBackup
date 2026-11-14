import type { Job, Override } from "./types";

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** true se `relPath` è dentro (o uguale a) la sottocartella `overrideRelPath` */
function isWithin(relPath: string, overrideRelPath: string): boolean {
  if (overrideRelPath === "") return true;
  return relPath === overrideRelPath || relPath.startsWith(overrideRelPath + "/");
}

/**
 * Risolve la destinazione effettiva per un file della sorgente, dato il job.
 * Vince l'override con il percorso più specifico (il più lungo) che contiene il file;
 * in assenza di override applicabili si usa la destinazione di default del job.
 */
export function resolveDestinationRoot(job: Job, fileRelPath: string): string {
  const rel = normalize(fileRelPath);
  let best: Override | undefined;

  for (const ov of job.overrides) {
    const ovRel = normalize(ov.relativePath);
    if (isWithin(rel, ovRel)) {
      if (!best || normalize(best.relativePath).length < ovRel.length) {
        best = ov;
      }
    }
  }

  return best ? best.destination : job.defaultDestination;
}

/** Raggruppa tutte le destinazioni effettivamente coinvolte da un job (default + override) */
export function listDestinationRoots(job: Job): string[] {
  const set = new Set<string>([job.defaultDestination]);
  for (const ov of job.overrides) set.add(ov.destination);
  return Array.from(set);
}

export interface Region {
  /** "" per la regione di default (tutta la sourceRoot salvo le sottocartelle con override) */
  relativePath: string;
  destination: string;
}

/** Una regione per la destinazione di default più una per ogni override */
export function buildRegions(job: Job): Region[] {
  return [
    { relativePath: "", destination: job.defaultDestination },
    ...job.overrides.map((ov) => ({ relativePath: normalize(ov.relativePath), destination: ov.destination })),
  ];
}

/**
 * Sottocartelle (relative alla sourceRoot) da escludere quando si copia l'intera regione `region`,
 * perché appartengono a una regione annidata con destinazione diversa.
 */
export function computeExcludeRelPaths(regions: Region[], region: Region): string[] {
  return regions
    .filter((other) => other !== region && other.destination !== region.destination && isWithin(other.relativePath, region.relativePath) && other.relativePath !== region.relativePath)
    .map((other) => other.relativePath);
}
