/// <reference path="./global.d.ts" />
import type { Job } from "../core/types";

let currentJob: Job | null = null;
let selectedRelPath: string | null = null;
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
    li.innerHTML = `<span>${ov.relativePath || "(sorgente principale)"} → ${ov.destination}</span>`;
    const removeBtn = document.createElement("button");
    removeBtn.className = "secondary";
    removeBtn.textContent = "Rimuovi";
    removeBtn.onclick = async () => {
      if (!currentJob) return;
      currentJob = await window.api.removeOverride({ jobId: currentJob.id, relativePath: ov.relativePath });
      renderOverrides();
      await renderTree();
      updateSelectionState();
    };
    li.appendChild(removeBtn);
    overridesList.appendChild(li);
  }
}

function findOverrideFor(relPath: string) {
  return currentJob?.overrides.find((o) => o.relativePath === relPath);
}

function updateSelectionState(): void {
  const hasSelection = selectedRelPath !== null;
  assignOverrideBtn.disabled = !hasSelection;
  removeOverrideBtn.disabled = !hasSelection || !findOverrideFor(selectedRelPath ?? "");
  selectedPathLabel.textContent = hasSelection
    ? `Selezionata: ${selectedRelPath === "" ? "(cartella sorgente principale)" : selectedRelPath}`
    : "Nessuna sottocartella selezionata";
}

async function loadChildren(relPath: string): Promise<string[]> {
  if (childrenCache.has(relPath)) return childrenCache.get(relPath) as string[];
  if (!currentJob) return [];
  const children = await window.api.listSubfolders({ jobId: currentJob.id, relativePath: relPath });
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
  toggle.onclick = async (ev) => {
    ev.stopPropagation();
    if (expandedPaths.has(relPath)) expandedPaths.delete(relPath);
    else {
      expandedPaths.add(relPath);
      await loadChildren(relPath);
    }
    await renderTree();
  };
  row.appendChild(toggle);

  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = label;
  name.onclick = async () => {
    selectedRelPath = relPath;
    updateSelectionState();
    await renderTree();
  };
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

async function renderTree(): Promise<void> {
  sourceTreeEl.innerHTML = "";
  if (!currentJob) return;
  sourceTreeEl.appendChild(await buildTreeNode("", currentJob.sourceRoot));
}

function selectJob(job: Job): void {
  currentJob = job;
  overridesSection.style.display = "block";
  actionsSection.style.display = "block";
  selectedRelPath = null;
  expandedPaths.clear();
  expandedPaths.add("");
  childrenCache.clear();
  renderOverrides();
  updateSelectionState();
  void renderTree();
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

assignOverrideBtn.addEventListener("click", async () => {
  if (!currentJob || selectedRelPath === null) return;
  const folder = await window.api.selectFolder();
  if (!folder) return;
  currentJob = await window.api.setOverride({ jobId: currentJob.id, relativePath: selectedRelPath, destination: folder });
  renderOverrides();
  updateSelectionState();
  await renderTree();
});

removeOverrideBtn.addEventListener("click", async () => {
  if (!currentJob || selectedRelPath === null) return;
  currentJob = await window.api.removeOverride({ jobId: currentJob.id, relativePath: selectedRelPath });
  renderOverrides();
  updateSelectionState();
  await renderTree();
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
