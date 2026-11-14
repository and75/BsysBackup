import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Job, Override } from "./types";
import { normalizeRelPath } from "./router";

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
  const overrides: Override[] = job.overrides.filter((o) => o.relativePath !== normalized);
  overrides.push({ relativePath: normalized, destination });
  return { ...job, overrides };
}

export function removeOverride(job: Job, relativePath: string): Job {
  const normalized = normalizeRelPath(relativePath);
  return { ...job, overrides: job.overrides.filter((o) => o.relativePath !== normalized) };
}

export async function saveJob(jobsDir: string, job: Job): Promise<string> {
  await mkdir(jobsDir, { recursive: true });
  const path = join(jobsDir, `${job.id}.json`);
  await writeFile(path, JSON.stringify(job, null, 2), "utf-8");
  return path;
}

export async function loadJob(jobsDir: string, jobId: string): Promise<Job> {
  const path = join(jobsDir, `${jobId}.json`);
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as Job;
}
