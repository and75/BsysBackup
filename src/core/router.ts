import { join } from "node:path";
import type { Job, Override } from "./types";

export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Windows non distingue maiuscole e minuscole nei percorsi: confrontarli alla lettera farebbe
 * vedere come "nuovi" tutti i file di una cartella rinominata solo nelle maiuscole.
 */
let caseInsensitivePaths = process.platform === "win32";

export function setCaseInsensitivePaths(value: boolean): void {
  caseInsensitivePaths = value;
}

/** Chiave di confronto di un percorso relativo; per leggere o scrivere si usa sempre il percorso reale */
export function pathKey(relPath: string): string {
  return caseInsensitivePaths ? relPath.toLowerCase() : relPath;
}

export function toAbs(root: string, relPath: string): string {
  return relPath ? join(root, ...relPath.split("/")) : root;
}

/** true se `relPath` è dentro (o uguale a) la sottocartella `ancestorRelPath` */
function isWithin(relPath: string, ancestorRelPath: string): boolean {
  if (ancestorRelPath === "") return true;
  const rel = pathKey(relPath);
  const ancestor = pathKey(ancestorRelPath);
  return rel === ancestor || rel.startsWith(ancestor + "/");
}

/** L'override più specifico (percorso più lungo) che contiene il file, se esiste */
function findOverride(job: Job, fileRelPath: string): Override | undefined {
  const rel = normalizeRelPath(fileRelPath);
  let best: Override | undefined;
  let bestLength = -1;

  for (const ov of job.overrides) {
    const ovRel = normalizeRelPath(ov.relativePath);
    if (isWithin(rel, ovRel) && ovRel.length > bestLength) {
      best = ov;
      bestLength = ovRel.length;
    }
  }
  return best;
}

/** Destinazione effettiva di un file: quella dell'override più specifico, altrimenti il default del job */
export function resolveDestinationRoot(job: Job, fileRelPath: string): string {
  return findOverride(job, fileRelPath)?.destination ?? job.defaultDestination;
}

/** Percorso relativo della regione a cui appartiene il file ("" = regione di default) */
export function resolveRegionPath(job: Job, fileRelPath: string): string {
  const ov = findOverride(job, fileRelPath);
  return ov ? normalizeRelPath(ov.relativePath) : "";
}

/** Tutte le destinazioni coinvolte da un job (default + override) */
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
    ...job.overrides.map((ov) => ({ relativePath: normalizeRelPath(ov.relativePath), destination: ov.destination })),
  ];
}

/**
 * Sottocartelle (relative alla sourceRoot) da escludere quando si copia l'intera regione `region`,
 * perché appartengono a una regione annidata con destinazione diversa.
 */
export function computeExcludeRelPaths(regions: Region[], region: Region): string[] {
  return regions
    .filter(
      (other) =>
        pathKey(other.relativePath) !== pathKey(region.relativePath) &&
        other.destination !== region.destination &&
        isWithin(other.relativePath, region.relativePath)
    )
    .map((other) => other.relativePath);
}

export interface RegionCopyPlan {
  relativePath: string;
  destinationRoot: string;
  sourceDir: string;
  /** Mantiene il percorso relativo dentro la destinazione, come fanno differ e verifier */
  destDir: string;
  excludeDirs: string[];
}

/** Coppie cartella sorgente → cartella destinazione da passare a un copiatore "ad albero" (Robocopy) */
export function planRegionCopies(job: Job): RegionCopyPlan[] {
  const regions = buildRegions(job);
  return regions.map((region) => ({
    relativePath: region.relativePath,
    destinationRoot: region.destination,
    sourceDir: toAbs(job.sourceRoot, region.relativePath),
    destDir: toAbs(region.destination, region.relativePath),
    excludeDirs: computeExcludeRelPaths(regions, region).map((rel) => toAbs(job.sourceRoot, rel)),
  }));
}
