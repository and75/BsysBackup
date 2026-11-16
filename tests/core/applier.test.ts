import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyProposals } from "../../src/core/applier";
import { createJob, followReorganization, followReorganizationAt } from "../../src/core/job";
import { pathExists } from "../../src/core/scanner";
import type { ApplyOutcome, ReorgAction, ReorgProposal } from "../../src/core/types";

let base: string;
let root: string;
let bin: string;

const at = (relPath: string) => join(root, ...relPath.split("/"));
const exists = (relPath: string) => pathExists(at(relPath));
const read = (relPath: string) => readFile(at(relPath), "utf-8");

async function put(relPath: string, content: string): Promise<void> {
  await mkdir(dirname(at(relPath)), { recursive: true });
  await writeFile(at(relPath), content);
}

/** Cestino finto: sposta in una cartella fuori dalla sorgente e ricorda cosa ha ricevuto */
const trashed: string[] = [];
async function trash(abs: string): Promise<void> {
  trashed.push(abs.slice(root.length + 1).split("\\").join("/"));
  await rename(abs, join(bin, String(trashed.length)));
}

const proposal = (action: ReorgAction, from: string, to: string): ReorgProposal => ({ action, from, to, reason: "" });
const apply = async (...proposals: ReorgProposal[]) => applyProposals(root, proposals, { trash });

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "bsys-apply-"));
  root = join(base, "sorgente");
  bin = join(base, "cestino");
  await mkdir(root);
  await mkdir(bin);
  trashed.length = 0;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("applyProposals: sposta e rinomina", () => {
  it("sposta una cartella in un nuovo percorso, creando le cartelle intermedie", async () => {
    await put("fatt_23/gennaio.pdf", "fattura");
    const [outcome] = await apply(proposal("move", "fatt_23", "Documenti/Fatture/2023"));
    expect(outcome.status).toBe("done");
    expect(outcome.fromGone).toBe(true);
    expect(await read("Documenti/Fatture/2023/gennaio.pdf")).toBe("fattura");
    expect(await exists("fatt_23")).toBe(false);
  });

  it("non sovrascrive una destinazione che esiste già", async () => {
    await put("A/uno.txt", "uno");
    await put("B/due.txt", "due");
    const [outcome] = await apply(proposal("rename", "A", "B"));
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toMatch(/non viene sovrascritto/);
    expect(await read("A/uno.txt")).toBe("uno");
    expect(await read("B/due.txt")).toBe("due");
  });

  it("rifiuta una cartella sparita e i percorsi che escono dalla sorgente", async () => {
    await put("A/uno.txt", "uno");
    const outcomes = await apply(proposal("move", "Sparita", "Altro"), proposal("move", "A", "../fuori"), proposal("move", "A", "A/dentro"));
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "failed", "failed"]);
    expect(await exists("A/uno.txt")).toBe(true);
    expect(await pathExists(join(base, "fuori"))).toBe(false);
  });

  it("prosegue con le altre proposte dopo una che non si può applicare", async () => {
    await put("A/uno.txt", "uno");
    const outcomes = await apply(proposal("move", "Sparita", "Altro"), proposal("rename", "A", "Archivio"));
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "done"]);
    expect(await exists("Archivio/uno.txt")).toBe(true);
  });
});

describe("applyProposals: unisci", () => {
  it("sposta il contenuto nell'altra cartella, anche nelle sottocartelle, ed elimina quella rimasta vuota", async () => {
    await put("Scarica/nuovo.pdf", "nuovo");
    await put("Scarica/2024/marzo.pdf", "marzo");
    await put("Documenti/vecchio.pdf", "vecchio");
    await put("Documenti/2024/gennaio.pdf", "gennaio");
    const [outcome] = await apply(proposal("merge", "Scarica", "Documenti"));
    expect(outcome.status).toBe("done");
    expect(outcome.fromGone).toBe(true);
    expect((await readdir(at("Documenti"))).sort()).toEqual(["2024", "nuovo.pdf", "vecchio.pdf"]);
    expect((await readdir(at("Documenti/2024"))).sort()).toEqual(["gennaio.pdf", "marzo.pdf"]);
    expect(await exists("Scarica")).toBe(false);
  });

  it("manda nel Cestino un file già presente identico e lascia al suo posto quello diverso con lo stesso nome", async () => {
    await put("Scarica/uguale.pdf", "stesso contenuto");
    await put("Scarica/diverso.pdf", "versione di Scarica");
    await put("Documenti/uguale.pdf", "stesso contenuto");
    await put("Documenti/diverso.pdf", "versione di Documenti");
    const [outcome] = await apply(proposal("merge", "Scarica", "Documenti"));
    expect(outcome.status).toBe("partial");
    expect(outcome.fromGone).toBe(false);
    expect(outcome.detail).toMatch(/diverso\.pdf/);
    expect(trashed).toEqual(["Scarica/uguale.pdf"]);
    expect(await read("Scarica/diverso.pdf")).toBe("versione di Scarica");
    expect(await read("Documenti/diverso.pdf")).toBe("versione di Documenti");
  });

  it("unisce una sottocartella in quella che la contiene", async () => {
    await put("Foto/Nuova cartella/mare.jpg", "mare");
    await put("Foto/monti.jpg", "monti");
    const [outcome] = await apply(proposal("merge", "Foto/Nuova cartella", "Foto"));
    expect(outcome.status).toBe("done");
    expect((await readdir(at("Foto"))).sort()).toEqual(["mare.jpg", "monti.jpg"]);
  });

  it("rifiuta di unire una cartella a una sua sottocartella o a una cartella sparita", async () => {
    await put("Foto/2024/mare.jpg", "mare");
    const outcomes = await apply(proposal("merge", "Foto", "Foto/2024"), proposal("merge", "Foto", "Sparita"));
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "failed"]);
    expect(await exists("Foto/2024/mare.jpg")).toBe(true);
  });
});

describe("applyProposals: elimina la copia", () => {
  it("manda nel Cestino una cartella identica a quella da conservare", async () => {
    for (const dir of ["Foto", "Vecchio/Foto - Copia"]) {
      await put(`${dir}/mare.jpg`, "mare");
      await put(`${dir}/2024/monti.jpg`, "monti");
    }
    const [outcome] = await apply(proposal("removeDuplicate", "Vecchio/Foto - Copia", "Foto"));
    expect(outcome.status).toBe("done");
    expect(trashed).toEqual(["Vecchio/Foto - Copia"]);
    expect(await exists("Foto/2024/monti.jpg")).toBe(true);
  });

  it("non elimina una copia che nel frattempo è cambiata", async () => {
    await put("Foto/mare.jpg", "mare");
    await put("Copia/mare.jpg", "mare");
    await put("Copia/solo-qui.jpg", "foto aggiunta dopo la ricerca");
    await put("a.txt", "versione 1");
    await put("b.txt", "versione 2");
    const outcomes = await apply(proposal("removeDuplicate", "Copia", "Foto"), proposal("removeDuplicate", "b.txt", "a.txt"));
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "failed"]);
    expect(outcomes[0].detail).toMatch(/non è più identica/);
    expect(trashed).toEqual([]);
    expect(await exists("Copia/solo-qui.jpg")).toBe(true);
  });

  it("manda nel Cestino un file identico e rifiuta di eliminare qualcosa rispetto a se stesso", async () => {
    await put("Documenti/contratto.pdf", "contratto");
    await put("Scarica/contratto (1).pdf", "contratto");
    const outcomes = await apply(
      proposal("removeDuplicate", "Scarica/contratto (1).pdf", "Documenti/contratto.pdf"),
      proposal("removeDuplicate", "Documenti/contratto.pdf", "Documenti/contratto.pdf"),
      proposal("removeDuplicate", "Documenti/contratto.pdf", "Scarica/contratto (1).pdf")
    );
    expect(outcomes.map((o) => o.status)).toEqual(["done", "failed", "failed"]);
    expect(trashed).toEqual(["Scarica/contratto (1).pdf"]);
    expect(await read("Documenti/contratto.pdf")).toBe("contratto");
  });
});

describe("applyProposals: annullamento", () => {
  it("non applica le proposte successive all'annullamento", async () => {
    await put("A/uno.txt", "uno");
    await put("B/due.txt", "due");
    const abort = new AbortController();
    const outcomes = await applyProposals(root, [proposal("rename", "A", "A2"), proposal("rename", "B", "B2")], {
      trash,
      signal: abort.signal,
      onProgress: (done) => done === 1 && abort.abort(),
    });
    expect(outcomes.map((o) => o.status)).toEqual(["done", "failed"]);
    expect(await exists("B/due.txt")).toBe(true);
  });
});

describe("followReorganization", () => {
  const done = (action: ReorgAction, from: string, to: string, fromGone = true): ApplyOutcome => ({ proposal: proposal(action, from, to), status: "done", detail: "", fromGone });
  const job = {
    ...createJob({ name: "Prova", sourceRoot: "/s", defaultDestination: "/d" }),
    overrides: [
      { relativePath: "Foto", destination: "E:/foto" },
      { relativePath: "Foto/2024", destination: "F:/recenti" },
      { relativePath: "Documenti", destination: "G:/doc" },
    ],
    excludedPaths: [{ relativePath: "Foto/scarti", isDirectory: true }],
  };
  const paths = (j: typeof job) => [...j.overrides.map((o) => `${o.relativePath} -> ${o.destination}`), ...j.excludedPaths.map((e) => `escluso ${e.relativePath}`)];

  it("dopo uno spostamento porta destinazioni ed esclusioni nella nuova posizione", () => {
    expect(paths(followReorganization(job, [done("move", "Foto", "Archivio/Immagini")]))).toEqual([
      "Archivio/Immagini -> E:/foto",
      "Archivio/Immagini/2024 -> F:/recenti",
      "Documenti -> G:/doc",
      "escluso Archivio/Immagini/scarti",
    ]);
  });

  it("dopo un'unione lascia decadere la regola della cartella sparita, senza toccare quella di arrivo", () => {
    expect(paths(followReorganization(job, [done("merge", "Foto", "Documenti")]))).toEqual(["Documenti/2024 -> F:/recenti", "Documenti -> G:/doc", "escluso Documenti/scarti"]);
  });

  it("dopo l'eliminazione di una copia toglie le regole che la riguardavano", () => {
    expect(paths(followReorganization(job, [done("removeDuplicate", "Foto", "Altro")]))).toEqual(["Documenti -> G:/doc"]);
  });

  it("non cambia nulla se nella posizione di partenza è rimasto qualcosa", () => {
    expect(followReorganization(job, [done("merge", "Foto", "Documenti", false)])).toEqual(job);
  });

  it("unendo una sottocartella nella radice della sorgente, le regole delle sue parti salgono di un livello", () => {
    const flat = followReorganization(job, [done("merge", "Foto", "")]);
    expect(paths(flat)).toEqual(["2024 -> F:/recenti", "Documenti -> G:/doc", "escluso scarti"]);
  });
});

describe("followReorganizationAt", () => {
  const done = (action: ReorgAction, from: string, to: string): ApplyOutcome => ({ proposal: proposal(action, from, to), status: "done", detail: "", fromGone: true });
  const source = join(tmpdir(), "bsys-archivio", "Lavoro");
  const job = {
    ...createJob({ name: "Lavoro", sourceRoot: source, defaultDestination: "/d" }),
    overrides: [{ relativePath: "Clienti/Rossi", destination: "E:/rossi" }],
    excludedPaths: [{ relativePath: "Clienti/Rossi/bozze", isDirectory: true }],
  };
  const rules = (j: typeof job) => [...j.overrides.map((o) => o.relativePath), ...j.excludedPaths.map((e) => `escluso ${e.relativePath}`)];

  it("segue una riorganizzazione fatta direttamente nella sorgente", () => {
    expect(rules(followReorganizationAt(job, source, [done("rename", "Clienti", "Committenti")]))).toEqual(["Committenti/Rossi", "escluso Committenti/Rossi/bozze"]);
  });

  it("segue una riorganizzazione fatta in una sottocartella della sorgente", () => {
    const updated = followReorganizationAt(job, join(source, "Clienti"), [done("move", "Rossi", "Archivio/Rossi")]);
    expect(rules(updated)).toEqual(["Clienti/Archivio/Rossi", "escluso Clienti/Archivio/Rossi/bozze"]);
    expect(updated.sourceRoot).toBe(source);
  });

  it("segue una riorganizzazione fatta in una cartella che contiene la sorgente", () => {
    const updated = followReorganizationAt(job, dirname(source), [done("rename", "Lavoro/Clienti", "Lavoro/Committenti")]);
    expect(rules(updated)).toEqual(["Committenti/Rossi", "escluso Committenti/Rossi/bozze"]);
  });

  it("punta alla nuova posizione quando viene spostata la sorgente stessa, o una cartella che la contiene", () => {
    const renamed = followReorganizationAt(job, dirname(source), [done("rename", "Lavoro", "Ufficio")]);
    expect(renamed.sourceRoot).toBe(join(dirname(source), "Ufficio"));
    expect(rules(renamed)).toEqual(rules(job));
    const moved = followReorganizationAt(job, dirname(dirname(source)), [done("move", "bsys-archivio", "Vecchi/archivio")]);
    expect(moved.sourceRoot).toBe(join(dirname(dirname(source)), "Vecchi", "archivio", "Lavoro"));
  });

  it("lascia decadere le regole di ciò che esce dalla sorgente", () => {
    const updated = followReorganizationAt(job, dirname(source), [done("move", "Lavoro/Clienti/Rossi", "Altrove/Rossi")]);
    expect(rules(updated)).toEqual([]);
    expect(updated.sourceRoot).toBe(source);
  });

  it("non tocca un backup che non riguarda la cartella riordinata", () => {
    expect(followReorganizationAt(job, join(tmpdir(), "bsys-altro"), [done("rename", "Clienti", "Committenti")])).toEqual(job);
    expect(followReorganizationAt(job, dirname(source), [done("rename", "Privato", "Personale")])).toEqual(job);
  });
});
