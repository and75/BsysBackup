/// <reference path="./global.d.ts" />
import type { Job } from "../core/types";

let currentJob: Job | null = null;
let selectedRelPath: string | null = null;
let treeRenderToken = 0;
const expandedPaths = new Set<string>([""]);
const childrenCache = new Map<string, string[]>();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const jobSelect = $<HTMLSelectElement>("jobSelect");
const jobNameInput = $<HTMLInputElement>("jobName");
const sourceRootInput = $<HTMLInputElement>("sourceRoot");
const defaultDestinationInput = $<HTMLInputElement>("defaultDestination");
const sourceTreeEl = $<HTMLUListElement>("sourceTree");
const selectedPathLabel = $<HTMLDivElement>("selectedPathLabel");
const assignOverrideBtn = $<HTMLButtonElement>("assignOverrideBtn");
const removeOverrideBtn = $<HTMLButtonElement>("removeOverrideBtn");
const overridesList = $<HTMLUListElement>("overridesList");
const overridesSection = $<HTMLElement>("overridesSection");
const actionsSection = $<HTMLElement>("actionsSection");
const verifyWithHashInput = $<HTMLInputElement>("verifyWithHash");
const previewBtn = $<HTMLButtonElement>("previewBtn");
const runBtn = $<HTMLButtonElement>("runBtn");
const progressEl = $<HTMLDivElement>("progress");
const logEl = $<HTMLDivElement>("log");

function log(text: string): void {
  logEl.textContent += `${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

/** Collega un handler asincrono a un click mostrando nel log gli errori invece di perderli */
function onClick(el: HTMLElement, handler: () => Promise<void>): void {
  el.addEventListener("click", () => {
    handler().catch((err) => log(`ERRORE: ${err instanceof Error ? err.message : String(err)}`));
  });
}

function setBusy(busy: boolean): void {
  previewBtn.disabled = busy;
  runBtn.disabled = busy;
}

function findOverrideFor(relPath: string) {
  return currentJob?.overrides.find((o) => o.relativePath === relPath);
}

async function applyJobUpdate(job: Job): Promise<void> {
  currentJob = job;
  renderOverrides();
  updateSelectionState();
  await renderTree();
}

function renderOverrides(): void {
  overridesList.replaceChildren();
  if (!currentJob) return;
  for (const ov of currentJob.overrides) {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = `${ov.relativePath} → ${ov.destination}`;
    const removeBtn = document.createElement("button");
    removeBtn.className = "secondary";
    removeBtn.textContent = "Rimuovi";
    onClick(removeBtn, async () => {
      if (!currentJob) return;
      await applyJobUpdate(await window.api.removeOverride({ jobId: currentJob.id, relativePath: ov.relativePath }));
    });
    li.append(text, removeBtn);
    overridesList.appendChild(li);
  }
}

function updateSelectionState(): void {
  const isSubfolder = selectedRelPath !== null && selectedRelPath !== "";
  assignOverrideBtn.disabled = !isSubfolder;
  removeOverrideBtn.disabled = !isSubfolder || !findOverrideFor(selectedRelPath as string);
  if (selectedRelPath === null) selectedPathLabel.textContent = "Nessuna sottocartella selezionata";
  else if (selectedRelPath === "") selectedPathLabel.textContent = "Cartella principale: usa la destinazione di default del job";
  else selectedPathLabel.textContent = `Selezionata: ${selectedRelPath}`;
}

async function loadChildren(relPath: string): Promise<string[]> {
  const cached = childrenCache.get(relPath);
  if (cached) return cached;
  if (!currentJob) return [];
  const jobId = currentJob.id;
  const children = await window.api.listSubfolders({ jobId, relativePath: relPath });
  if (currentJob?.id !== jobId) return [];
  childrenCache.set(relPath, children);
  return children;
}

async function buildTreeNode(relPath: string, label: string): Promise<HTMLLIElement> {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row" + (selectedRelPath === relPath ? " selected" : "");

  const toggle = document.createElement("span");
  toggle.className = "tree-toggle";
  toggle.textContent = expandedPaths.has(relPath) ? "▾" : "▸";
  onClick(toggle, async () => {
    if (expandedPaths.has(relPath)) expandedPaths.delete(relPath);
    else expandedPaths.add(relPath);
    await renderTree();
  });
  row.appendChild(toggle);

  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = label;
  onClick(name, async () => {
    selectedRelPath = relPath;
    updateSelectionState();
    await renderTree();
  });
  row.appendChild(name);

  const override = findOverrideFor(relPath);
  if (override) {
    const badge = document.createElement("span");
    badge.className = "tree-badge";
    badge.textContent = `→ ${override.destination}`;
    row.appendChild(badge);
  }

  li.appendChild(row);

  if (expandedPaths.has(relPath)) {
    const children = await loadChildren(relPath);
    if (children.length > 0) {
      const ul = document.createElement("ul");
      ul.className = "tree-children";
      for (const childName of children) {
        const childRel = relPath ? `${relPath}/${childName}` : childName;
        ul.appendChild(await buildTreeNode(childRel, childName));
      }
      li.appendChild(ul);
    }
  }

  return li;
}

/** Costruisce l'albero fuori dal DOM e lo sostituisce in un colpo solo; un render superato da uno più recente viene scartato */
async function renderTree(): Promise<void> {
  const token = ++treeRenderToken;
  if (!currentJob) {
    sourceTreeEl.replaceChildren();
    return;
  }
  const root = await buildTreeNode("", currentJob.sourceRoot);
  if (token === treeRenderToken) sourceTreeEl.replaceChildren(root);
}

async function selectJob(job: Job): Promise<void> {
  overridesSection.style.display = "block";
  actionsSection.style.display = "block";
  selectedRelPath = null;
  expandedPaths.clear();
  expandedPaths.add("");
  childrenCache.clear();
  verifyWithHashInput.checked = job.verifyWithHash;
  log(`Job selezionato: ${job.name}`);
  await applyJobUpdate(job);
}

async function refreshJobSelect(selectId?: string): Promise<Job[]> {
  const jobs = await window.api.listJobs();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "— nessuno —";
  jobSelect.replaceChildren(placeholder);
  for (const job of jobs) {
    const opt = document.createElement("option");
    opt.value = job.id;
    opt.textContent = job.name;
    jobSelect.appendChild(opt);
  }
  if (selectId) jobSelect.value = selectId;
  return jobs;
}

async function pickFolderInto(input: HTMLInputElement): Promise<void> {
  const folder = await window.api.selectFolder();
  if (folder) input.value = folder;
}

jobSelect.addEventListener("change", () => {
  const jobId = jobSelect.value;
  if (!jobId) return;
  window.api
    .listJobs()
    .then((jobs) => {
      const job = jobs.find((j) => j.id === jobId);
      if (job) return selectJob(job);
    })
    .catch((err) => log(`ERRORE: ${err instanceof Error ? err.message : String(err)}`));
});

onClick($("pickSource"), () => pickFolderInto(sourceRootInput));
onClick($("pickDest"), () => pickFolderInto(defaultDestinationInput));

onClick($("createJobBtn"), async () => {
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
  await selectJob(job);
});

onClick(assignOverrideBtn, async () => {
  if (!currentJob || !selectedRelPath) return;
  const relativePath = selectedRelPath;
  const folder = await window.api.selectFolder();
  if (!folder) return;
  await applyJobUpdate(await window.api.setOverride({ jobId: currentJob.id, relativePath, destination: folder }));
});

onClick(removeOverrideBtn, async () => {
  if (!currentJob || !selectedRelPath) return;
  await applyJobUpdate(await window.api.removeOverride({ jobId: currentJob.id, relativePath: selectedRelPath }));
});

function logWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  log(`Avvisi (${warnings.length}):`);
  for (const w of warnings.slice(0, 50)) log(`  ${w}`);
  if (warnings.length > 50) log(`  … e altri ${warnings.length - 50}`);
}

onClick(previewBtn, async () => {
  if (!currentJob) return;
  logEl.textContent = "";
  progressEl.textContent = "";
  log("Analisi in corso…");
  setBusy(true);
  try {
    const preview = await window.api.previewJob({ jobId: currentJob.id });
    const changed = preview.planned.filter((f) => f.action !== "unchanged");
    log(`Nuovi/modificati: ${changed.length}  Invariati: ${preview.planned.length - changed.length}  Rimossi dalla sorgente: ${preview.removedFromSource.length}`);
    if (preview.unreachableDestinations.length > 0) {
      log(`ATTENZIONE — destinazioni non raggiungibili: ${preview.unreachableDestinations.join(", ")}`);
    }
    logWarnings(preview.warnings);
    for (const f of changed.slice(0, 200)) log(`  [${f.action}] ${f.relPath} → ${f.destinationRoot}`);
    if (changed.length > 200) log(`  … e altri ${changed.length - 200}`);
  } finally {
    setBusy(false);
  }
});

onClick(runBtn, async () => {
  if (!currentJob) return;
  logEl.textContent = "";
  progressEl.textContent = "";
  log("Backup in corso…");
  setBusy(true);
  try {
    const report = await window.api.runJob({ jobId: currentJob.id, verifyWithHash: verifyWithHashInput.checked });
    progressEl.textContent = "";
    log(`Copiati e controllati: ${report.totalCopied}  Falliti: ${report.totalFailed}  Saltati (destinazione non raggiungibile): ${report.totalSkippedUnreachable}`);
    for (const dest of report.destinations) {
      if (!dest.reachable) log(`ATTENZIONE — destinazione non raggiungibile: ${dest.destinationRoot}`);
      for (const f of dest.failed) log(`  FALLITO: ${f.relPath} — ${f.error}`);
    }
    logWarnings(report.warnings);
    if (report.removedFromSource.length > 0) {
      log(`In destinazione ma non più nella sorgente (non cancellati): ${report.removedFromSource.length}`);
    }
  } finally {
    setBusy(false);
  }
});

window.api.onProgress((info) => {
  progressEl.textContent = `Verifica ${info.done}/${info.total}: ${info.relPath}`;
});

refreshJobSelect().catch((err) => log(`ERRORE: ${err instanceof Error ? err.message : String(err)}`));
