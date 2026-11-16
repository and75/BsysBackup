import { readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { ApplyOutcome, Job, Override } from "./types";
import { normalizeRelPath, pathKey } from "./router";

export function createJob(input: { name: string; sourceRoot: string; defaultDestination: string; verifyWithHash?: boolean }): Job {
  return {
    id: randomUUID(),
    name: input.name,
    sourceRoot: input.sourceRoot,
    defaultDestination: input.defaultDestination,
    overrides: [],
    excludedPaths: [],
    verifyWithHash: input.verifyWithHash ?? false,
  };
}

export function setOverride(job: Job, relativePath: string, destination: string): Job {
  const normalized = normalizeRelPath(relativePath);
  if (normalized === "") {
    throw new Error("La cartella principale usa la destinazione di default: l'override vale solo per le sottocartelle.");
  }
  const overrides: Override[] = job.overrides.filter((o) => pathKey(o.relativePath) !== pathKey(normalized));
  overrides.push({ relativePath: normalized, destination });
  return { ...job, overrides };
}

export function removeOverride(job: Job, relativePath: string): Job {
  const normalized = normalizeRelPath(relativePath);
  return { ...job, overrides: job.overrides.filter((o) => pathKey(o.relativePath) !== pathKey(normalized)) };
}

/**
 * Esclude una cartella o un file dal backup. Vale anche per tutto il contenuto, se è una
 * cartella: non si può reincludere un file dentro una cartella esclusa (vedi Job.excludedPaths).
 */
export function excludePath(job: Job, relativePath: string, isDirectory: boolean): Job {
  const normalized = normalizeRelPath(relativePath);
  if (normalized === "") {
    throw new Error("La cartella sorgente non può essere esclusa: elimina il backup invece.");
  }
  if (job.excludedPaths.some((ex) => pathKey(ex.relativePath) === pathKey(normalized))) return job;
  return { ...job, excludedPaths: [...job.excludedPaths, { relativePath: normalized, isDirectory }] };
}

/** Rimuove un'esclusione diretta. Non ha effetto su un percorso escluso solo perché dentro una cartella esclusa. */
export function includePath(job: Job, relativePath: string): Job {
  const normalized = normalizeRelPath(relativePath);
  return { ...job, excludedPaths: job.excludedPaths.filter((ex) => pathKey(ex.relativePath) !== pathKey(normalized)) };
}

function isUnder(relPath: string, ancestor: string): boolean {
  return pathKey(relPath).startsWith(pathKey(ancestor) + "/");
}

/**
 * Aggiorna destinazioni personalizzate ed esclusioni dopo che la sorgente è stata riordinata,
 * così continuano a valere per le stesse cartelle nella loro nuova posizione.
 */
export function followReorganization(job: Job, outcomes: ApplyOutcome[]): Job {
  let { overrides, excludedPaths } = job;
  for (const { proposal, fromGone } of outcomes) {
    // Se nella posizione di partenza è rimasto qualcosa, le sue regole devono restare
    if (!fromGone) continue;
    const from = normalizeRelPath(proposal.from);
    const to = normalizeRelPath(proposal.to);
    const follow = <T extends { relativePath: string }>(rules: T[]): T[] => {
      const result: T[] = [];
      for (const rule of rules) {
        const rel = normalizeRelPath(rule.relativePath);
        const exact = pathKey(rel) === pathKey(from);
        let moved: T | null = rule;
        if (proposal.action === "removeDuplicate") {
          if (exact || isUnder(rel, from)) moved = null;
        } else if (exact) {
          // In un'unione la cartella confluisce in un'altra, che ha già le sue regole: quella della cartella sparita decade
          moved = proposal.action === "merge" ? null : { ...rule, relativePath: to };
        } else if (isUnder(rel, from)) {
          // "to" è vuoto quando la cartella confluisce nella radice della sorgente
          moved = { ...rule, relativePath: (to ? `${to}/` : "") + rel.slice(from.length + 1) };
        }
        if (moved && !result.some((r) => pathKey(r.relativePath) === pathKey((moved as T).relativePath))) result.push(moved);
      }
      return result;
    };
    overrides = follow(overrides);
    excludedPaths = follow(excludedPaths);
  }
  return { ...job, overrides, excludedPaths };
}

/** Percorso di `inner` relativo a `outer` ("" se coincidono), o null se `inner` non sta dentro `outer` */
export function relativeWithin(outer: string, inner: string): string | null {
  const rel = relative(resolve(outer), resolve(inner));
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * Come followReorganization, ma per una riorganizzazione fatta in una cartella qualsiasi (`root`), con
 * proposte relative a quella: il backup la segue se la sua sorgente contiene quella cartella, ne è
 * contenuta o coincide. Un backup la cui sorgente è stata spostata o rinominata punta alla nuova posizione.
 */
export function followReorganizationAt(job: Job, root: string, outcomes: ApplyOutcome[]): Job {
  // La cartella riordinata è la sorgente o una sua parte: basta riportare i percorsi alla sorgente
  const below = relativeWithin(job.sourceRoot, root);
  if (below !== null) {
    const prefix = below ? `${below}/` : "";
    return followReorganization(
      job,
      outcomes.map((o) => ({ ...o, proposal: { ...o.proposal, from: prefix + normalizeRelPath(o.proposal.from), to: prefix + normalizeRelPath(o.proposal.to) } }))
    );
  }

  // La sorgente è una parte della cartella riordinata
  let source = relativeWithin(root, job.sourceRoot);
  if (source === null) return job;
  let result = job;
  for (const outcome of outcomes) {
    if (!outcome.fromGone) continue;
    const { action } = outcome.proposal;
    const from = normalizeRelPath(outcome.proposal.from);
    const to = normalizeRelPath(outcome.proposal.to);
    if (pathKey(source) === pathKey(from) || isUnder(source, from)) {
      // È stata spostata la sorgente stessa, o una cartella che la contiene. Se è confluita altrove o è finita nel
      // Cestino il backup resta com'è: risulterà scollegato, ed è l'utente a decidere che farne.
      if (action === "move" || action === "rename") {
        source = to + source.slice(from.length);
        result = { ...result, sourceRoot: join(resolve(root), ...source.split("/")) };
      }
    } else if (isUnder(from, source)) {
      const inside = (relPath: string) => relPath.slice(source!.length + 1);
      const staysInside = action !== "removeDuplicate" && (pathKey(to) === pathKey(source) || isUnder(to, source));
      // Ciò che esce dalla sorgente non fa più parte del backup: le sue regole decadono, come per ciò che viene eliminato
      const proposal = staysInside ? { ...outcome.proposal, from: inside(from), to: inside(to) } : { ...outcome.proposal, action: "removeDuplicate" as const, from: inside(from), to: "" };
      result = followReorganization(result, [{ ...outcome, proposal }]);
    }
  }
  return result;
}

export type JobChanges = Partial<Pick<Job, "name" | "sourceRoot" | "defaultDestination" | "verifyWithHash">>;

export function updateJob(job: Job, changes: JobChanges): Job {
  const updated = { ...job };
  if (changes.name !== undefined) {
    if (!changes.name.trim()) throw new Error("Il nome del backup non può essere vuoto.");
    updated.name = changes.name.trim();
  }
  if (changes.sourceRoot !== undefined) updated.sourceRoot = changes.sourceRoot;
  if (changes.defaultDestination !== undefined) updated.defaultDestination = changes.defaultDestination;
  if (changes.verifyWithHash !== undefined) updated.verifyWithHash = changes.verifyWithHash;
  return updated;
}

const JOB_ID_PATTERN = /^[0-9a-f-]{36}$/;

/** L'id diventa un nome di file: deve essere quello generato da createJob, non un percorso */
function jobPath(jobsDir: string, jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error("Identificativo del backup non valido");
  return join(jobsDir, `${jobId}.json`);
}

export async function saveJob(jobsDir: string, job: Job): Promise<string> {
  await mkdir(jobsDir, { recursive: true });
  const path = jobPath(jobsDir, job.id);
  await writeFile(path, JSON.stringify(job, null, 2), "utf-8");
  return path;
}

export async function loadJob(jobsDir: string, jobId: string): Promise<Job> {
  const job = JSON.parse(await readFile(jobPath(jobsDir, jobId), "utf-8")) as Job;
  // i backup salvati prima dell'introduzione delle esclusioni non hanno questo campo
  return { ...job, excludedPaths: job.excludedPaths ?? [] };
}

/** Elimina solo la configurazione: i file già copiati e i report restano dove sono */
export async function deleteJob(jobsDir: string, jobId: string): Promise<void> {
  await rm(jobPath(jobsDir, jobId), { force: true });
}

export async function listJobs(jobsDir: string): Promise<Job[]> {
  let names: string[];
  try {
    names = (await readdir(jobsDir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const jobs: Job[] = [];
  for (const name of names) {
    try {
      jobs.push(await loadJob(jobsDir, name.replace(/\.json$/, "")));
    } catch {
      // file estraneo o illeggibile: ignorato
    }
  }
  return jobs.sort((a, b) => a.name.localeCompare(b.name));
}
