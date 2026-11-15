import { lstat, mkdir, readdir, realpath, rename, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashFile } from "./hash";
import { normalizeRelPath, toAbs } from "./router";
import { scanDirectory } from "./scanner";
import type { ApplyOutcome, ReorgProposal } from "./types";

export interface ApplyOptions {
  /** Sposta un file o una cartella nel Cestino: nulla viene mai cancellato in modo definitivo */
  trash: (absPath: string) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Un problema che impedisce di applicare una proposta; il messaggio è già adatto a essere mostrato */
class Refusal extends Error {}

async function kindOf(path: string): Promise<"file" | "folder" | "other" | null> {
  try {
    const info = await lstat(path);
    return info.isDirectory() ? "folder" : info.isFile() ? "file" : "other";
  } catch {
    return null;
  }
}

/** Percorso assoluto di un percorso relativo alla sorgente, rifiutando tutto ciò che ne uscirebbe */
function inside(root: string, relPath: string): string {
  const rel = normalizeRelPath(relPath);
  if (rel === "" || rel.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Refusal(`Percorso non valido: ${relPath}`);
  }
  return toAbs(root, rel);
}

function isWithin(relPath: string, ancestor: string): boolean {
  return relPath.toLowerCase().startsWith(ancestor.toLowerCase() + "/");
}

async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  if (sa.size !== sb.size) return false;
  return (await hashFile(a)) === (await hashFile(b));
}

async function moveFolder(root: string, proposal: ReorgProposal): Promise<ApplyOutcome> {
  const from = inside(root, proposal.from);
  const to = inside(root, proposal.to);
  if ((await kindOf(from)) !== "folder") throw new Refusal(`La cartella ${proposal.from} non esiste più.`);
  if (isWithin(normalizeRelPath(proposal.to), normalizeRelPath(proposal.from))) throw new Refusal("Una cartella non può essere spostata dentro se stessa.");
  // Su Windows cambiare solo maiuscole e minuscole del nome è una rinomina lecita, anche se la destinazione "esiste"
  const caseOnly = proposal.from !== proposal.to && proposal.from.toLowerCase() === proposal.to.toLowerCase();
  if ((await kindOf(to)) !== null && !caseOnly) throw new Refusal(`Esiste già qualcosa in ${proposal.to}: non viene sovrascritto.`);
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return { proposal, status: "done", detail: `Ora si trova in ${proposal.to}`, fromGone: true };
}

interface MergeCount {
  moved: number;
  identical: number;
  conflicts: string[];
}

/** Sposta in `dst` ciò che c'è in `src` senza sovrascrivere: i file identici vanno nel Cestino, quelli diversi restano dove sono */
async function mergeInto(src: string, dst: string, relPath: string, count: MergeCount, opts: ApplyOptions): Promise<void> {
  for (const item of await readdir(src, { withFileTypes: true })) {
    opts.signal?.throwIfAborted();
    const s = join(src, item.name);
    const d = join(dst, item.name);
    const rel = relPath ? `${relPath}/${item.name}` : item.name;
    const existing = await kindOf(d);
    if (existing === null) {
      await rename(s, d);
      count.moved++;
    } else if (item.isDirectory() && existing === "folder") {
      await mergeInto(s, d, rel, count, opts);
      await rmdir(s).catch(() => {});
    } else if (item.isFile() && existing === "file" && (await sameFile(s, d))) {
      await opts.trash(s);
      count.identical++;
    } else {
      count.conflicts.push(rel);
    }
  }
}

async function mergeFolder(root: string, proposal: ReorgProposal, opts: ApplyOptions): Promise<ApplyOutcome> {
  const from = inside(root, proposal.from);
  const to = inside(root, proposal.to);
  if ((await kindOf(from)) !== "folder") throw new Refusal(`La cartella ${proposal.from} non esiste più.`);
  if ((await kindOf(to)) !== "folder") throw new Refusal(`La cartella ${proposal.to} non esiste più.`);
  if ((await realpath(from)) === (await realpath(to))) throw new Refusal("Le due cartelle sono la stessa.");
  if (isWithin(normalizeRelPath(proposal.to), normalizeRelPath(proposal.from))) throw new Refusal("Una cartella non può essere unita a una sua sottocartella.");

  const count: MergeCount = { moved: 0, identical: 0, conflicts: [] };
  await mergeInto(from, to, "", count, opts);
  const fromGone = await rmdir(from).then(
    () => true,
    () => false
  );

  const parts = [count.moved === 1 ? `1 elemento spostato in ${proposal.to}` : `${count.moved} elementi spostati in ${proposal.to}`];
  if (count.identical > 0) parts.push(count.identical === 1 ? "1 file identico messo nel Cestino" : `${count.identical} file identici messi nel Cestino`);
  if (count.conflicts.length > 0) {
    const shown = count.conflicts.slice(0, 5).join(", ");
    const more = count.conflicts.length > 5 ? ` e altri ${count.conflicts.length - 5}` : "";
    parts.push(`${count.conflicts.length === 1 ? "1 rimasto" : `${count.conflicts.length} rimasti`} in ${proposal.from} perché in ${proposal.to} esiste un file diverso con lo stesso nome (${shown}${more})`);
  }
  return { proposal, status: count.conflicts.length > 0 ? "partial" : "done", detail: parts.join("; "), fromGone };
}

/** Rilegge le due cartelle e conferma che contengono gli stessi file, con gli stessi nomi e lo stesso contenuto */
async function sameFolder(a: string, b: string, signal?: AbortSignal): Promise<boolean> {
  const [scanA, scanB] = await Promise.all([scanDirectory(a), scanDirectory(b)]);
  if (scanA.skipped.length > 0 || scanB.skipped.length > 0 || scanA.entries.length !== scanB.entries.length) return false;
  const sizes = new Map(scanB.entries.map((e) => [e.relPath, e.size]));
  if (scanA.entries.some((e) => sizes.get(e.relPath) !== e.size)) return false;
  for (const entry of scanA.entries) {
    signal?.throwIfAborted();
    if (entry.size > 0 && (await hashFile(toAbs(a, entry.relPath), signal)) !== (await hashFile(toAbs(b, entry.relPath), signal))) return false;
  }
  return true;
}

async function removeDuplicate(root: string, proposal: ReorgProposal, opts: ApplyOptions): Promise<ApplyOutcome> {
  const remove = inside(root, proposal.from);
  const keep = inside(root, proposal.to);
  const kind = await kindOf(remove);
  if (kind !== "file" && kind !== "folder") throw new Refusal(`${proposal.from} non esiste più.`);
  if ((await kindOf(keep)) !== kind) throw new Refusal(`La copia da conservare, ${proposal.to}, non esiste più.`);
  const [relRemove, relKeep] = [normalizeRelPath(proposal.from), normalizeRelPath(proposal.to)];
  if ((await realpath(remove)) === (await realpath(keep)) || isWithin(relRemove, relKeep) || isWithin(relKeep, relRemove)) {
    throw new Refusal("Le due copie sono la stessa cartella, o una contiene l'altra.");
  }
  // L'elenco dei duplicati può essere vecchio: si elimina solo ciò che è identico adesso
  const identical = kind === "file" ? await sameFile(remove, keep) : await sameFolder(remove, keep, opts.signal);
  if (!identical) throw new Refusal(`${proposal.from} non è più identica a ${proposal.to}: non è stata eliminata.`);
  await opts.trash(remove);
  return { proposal, status: "done", detail: `Ora è nel Cestino; resta ${proposal.to}`, fromGone: true };
}

/**
 * Applica alla sorgente le proposte scelte, una alla volta e nell'ordine dato. Ogni proposta viene
 * ricontrollata sul disco al momento di applicarla: non sovrascrive mai nulla e ciò che elimina va nel Cestino.
 * Una proposta che non si può applicare viene saltata e riportata, senza fermare le altre.
 */
export async function applyProposals(sourceRoot: string, proposals: ReorgProposal[], opts: ApplyOptions): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = [];
  for (const proposal of proposals) {
    opts.onProgress?.(outcomes.length, proposals.length);
    if (opts.signal?.aborted) {
      outcomes.push({ proposal, status: "failed", detail: "Non applicata: operazione annullata.", fromGone: false });
      continue;
    }
    try {
      if (proposal.action === "merge") outcomes.push(await mergeFolder(sourceRoot, proposal, opts));
      else if (proposal.action === "removeDuplicate") outcomes.push(await removeDuplicate(sourceRoot, proposal, opts));
      else outcomes.push(await moveFolder(sourceRoot, proposal));
    } catch (err) {
      const detail = err instanceof Refusal ? err.message : opts.signal?.aborted ? "Interrotta: operazione annullata." : `Non riuscita: ${(err as Error).message}`;
      outcomes.push({ proposal, status: "failed", detail, fromGone: false });
    }
  }
  opts.onProgress?.(proposals.length, proposals.length);
  return outcomes;
}

const STATUS_LABELS = { done: "FATTO", partial: "IN PARTE", failed: "NON APPLICATA" };
const ACTION_LABELS = { move: "Sposta", rename: "Rinomina", merge: "Unisci", removeDuplicate: "Elimina la copia" };

/** Elenco leggibile di ciò che è stato fatto: serve a ritrovare, o a rimettere a posto a mano, ciò che è stato spostato */
export function formatApplyLog(sourceRoot: string, outcomes: ApplyOutcome[], when: Date): string {
  const lines = [`Riorganizzazione di ${sourceRoot}`, `Data: ${when.toLocaleString("it-IT")}`, ""];
  for (const { proposal, status, detail } of outcomes) {
    const target = proposal.action === "removeDuplicate" ? `(resta ${proposal.to})` : `-> ${proposal.to}`;
    lines.push(`[${STATUS_LABELS[status]}] ${ACTION_LABELS[proposal.action]}: ${proposal.from} ${target}`, `    ${detail}`);
  }
  return lines.join("\r\n") + "\r\n";
}
