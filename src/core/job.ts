import { readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Job, Override } from "./types";
import { normalizeRelPath, pathKey } from "./router";

export function createJob(input: { name: string; sourceRoot: string; defaultDestination: string; verifyWithHash?: boolean }): Job {
  return {
    id: randomUUID(),
    name: input.name,
    sourceRoot: input.sourceRoot,
    defaultDestination: input.defaultDestination,
    overrides: [],
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
  return JSON.parse(await readFile(jobPath(jobsDir, jobId), "utf-8")) as Job;
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
