/// <reference path="./global.d.ts" />
import type { Job } from "../core/types";

let currentJob: Job | null = null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const jobSelect = $<HTMLSelectElement>("jobSelect");
const jobNameInput = $<HTMLInputElement>("jobName");
const sourceRootInput = $<HTMLInputElement>("sourceRoot");
const defaultDestinationInput = $<HTMLInputElement>("defaultDestination");
const overrideRelInput = $<HTMLInputElement>("overrideRel");
const overrideDestInput = $<HTMLInputElement>("overrideDest");
const overridesList = $<HTMLUListElement>("overridesList");
const overridesSection = $<HTMLElement>("overridesSection");
const actionsSection = $<HTMLElement>("actionsSection");
const logEl = $<HTMLDivElement>("log");

function log(text: string): void {
  logEl.textContent += `${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function renderOverrides(): void {
  overridesList.innerHTML = "";
  if (!currentJob) return;
  for (const ov of currentJob.overrides) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${ov.relativePath} → ${ov.destination}</span>`;
    const removeBtn = document.createElement("button");
    removeBtn.className = "secondary";
    removeBtn.textContent = "Rimuovi";
    removeBtn.onclick = async () => {
      if (!currentJob) return;
      currentJob = await window.api.removeOverride({ jobId: currentJob.id, relativePath: ov.relativePath });
      renderOverrides();
    };
    li.appendChild(removeBtn);
    overridesList.appendChild(li);
  }
}

function selectJob(job: Job): void {
  currentJob = job;
  overridesSection.style.display = "block";
  actionsSection.style.display = "block";
  renderOverrides();
  log(`Job selezionato: ${job.name}`);
}

async function refreshJobSelect(selectId?: string): Promise<void> {
  const jobs = await window.api.listJobs();
  jobSelect.innerHTML = '<option value="">— nessuno —</option>';
  for (const job of jobs) {
    const opt = document.createElement("option");
    opt.value = job.id;
    opt.textContent = job.name;
    jobSelect.appendChild(opt);
  }
  if (selectId) jobSelect.value = selectId;
}

jobSelect.addEventListener("change", async () => {
  if (!jobSelect.value) return;
  const jobs = await window.api.listJobs();
  const job = jobs.find((j) => j.id === jobSelect.value);
  if (job) selectJob(job);
});

$("pickSource").addEventListener("click", async () => {
  const folder = await window.api.selectFolder();
  if (folder) sourceRootInput.value = folder;
});

$("pickDest").addEventListener("click", async () => {
  const folder = await window.api.selectFolder();
  if (folder) defaultDestinationInput.value = folder;
});

$("pickOverrideDest").addEventListener("click", async () => {
  const folder = await window.api.selectFolder();
  if (folder) overrideDestInput.value = folder;
});

$("createJobBtn").addEventListener("click", async () => {
  if (!jobNameInput.value || !sourceRootInput.value || !defaultDestinationInput.value) {
    log("Compila nome, sorgente e destinazione di default prima di creare il job.");
    return;
  }
  const job = await window.api.createJob({
    name: jobNameInput.value,
    sourceRoot: sourceRootInput.value,
    defaultDestination: defaultDestinationInput.value,
  });
  await refreshJobSelect(job.id);
  selectJob(job);
});

$("addOverrideBtn").addEventListener("click", async () => {
  if (!currentJob) return;
  if (!overrideRelInput.value || !overrideDestInput.value) {
    log("Indica la sottocartella e la destinazione dedicata.");
    return;
  }
  currentJob = await window.api.setOverride({
    jobId: currentJob.id,
    relativePath: overrideRelInput.value,
    destination: overrideDestInput.value,
  });
  overrideRelInput.value = "";
  overrideDestInput.value = "";
  renderOverrides();
});

$("previewBtn").addEventListener("click", async () => {
  if (!currentJob) return;
  logEl.textContent = "";
  log("Analisi in corso…");
  const preview = await window.api.previewJob({ jobId: currentJob.id });
  const changed = preview.planned.filter((f) => f.action !== "unchanged");
  log(`Nuovi/modificati: ${changed.length}  Invariati: ${preview.planned.length - changed.length}  Rimossi dalla sorgente: ${preview.removedFromSource.length}`);
  if (preview.unreachableDestinations.length > 0) {
    log(`ATTENZIONE — destinazioni non raggiungibili: ${preview.unreachableDestinations.join(", ")}`);
  }
  for (const f of changed.slice(0, 200)) {
    log(`  [${f.action}] ${f.relPath} → ${f.destinationRoot}`);
  }
});

$("runBtn").addEventListener("click", async () => {
  if (!currentJob) return;
  logEl.textContent = "";
  log("Backup in corso…");
  const report = await window.api.runJob({ jobId: currentJob.id });
  log(`Copiati: ${report.totalCopied}  Falliti: ${report.totalFailed}  Saltati (destinazione irraggiungibile): ${report.totalSkippedUnreachable}`);
  for (const dest of report.destinations) {
    for (const f of dest.failed) log(`  FALLITO: ${f.relPath} — ${f.error}`);
  }
});

window.api.onProgress((info) => {
  log(`  (${info.done}/${info.total}) ${info.relPath}`);
});

refreshJobSelect();
