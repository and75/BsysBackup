import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SourceAnalysis } from "../../src/core/duplicates";
import { listModels, ollamaBaseUrl, pickDefaultModel } from "../../src/core/ollama";
import { describeSource, parseReply, proposeReorganization, validateProposals } from "../../src/core/organizer";
import type { FileEntry } from "../../src/core/types";

const year = (y: number) => new Date(`${y}-06-01T10:00:00Z`).getTime();
const file = (relPath: string, size = 1000, y = 2024): FileEntry => ({ relPath, size, mtimeMs: year(y) });

const analysis: SourceAnalysis = {
  sourceRoot: "/sorgente",
  skipped: [],
  entries: [
    file("Foto/mare.jpg", 3000, 2019),
    file("Foto/2024/monti.jpg", 2000, 2024),
    file("Vecchio/Foto - Copia/mare.jpg", 3000, 2019),
    file("Vecchio/Foto - Copia/2024/monti.jpg", 2000, 2024),
    file("Documenti/contratto.pdf", 500),
    file("Scarica/contratto (1).pdf", 500),
    file("fatt_23/gennaio.pdf", 100, 2023),
    file("sciolto.txt", 10),
  ],
  duplicates: {
    redundantFiles: 3,
    recoverableBytes: 5500,
    warnings: [],
    groups: [
      { kind: "folder", paths: ["Foto", "Vecchio/Foto - Copia"], copies: 2, size: 5000, fileCount: 2 },
      { kind: "file", paths: ["Documenti/contratto.pdf", "Scarica/contratto (1).pdf"], copies: 2, size: 500, fileCount: 1 },
    ],
  },
};

const valid = (raw: unknown[]) => validateProposals(raw, analysis);

describe("describeSource", () => {
  it("elenca le cartelle con quantità, tipi e anni, e i duplicati trovati", () => {
    const text = describeSource(analysis);
    expect(text).toContain("- Foto | 2 file, 4,9 KB, soprattutto jpg | anni 2019-2024");
    expect(text).toContain("- fatt_23 | 1 file, 100 byte, soprattutto pdf | anni 2023");
    expect(text).toContain("File sciolti nella cartella principale: 1");
    expect(text).toContain("- 2 cartelle identiche, 4,9 KB l'una: Foto | Vecchio/Foto - Copia");
  });

  it("con moltissime cartelle descrive solo i primi livelli", () => {
    const entries = Array.from({ length: 400 }, (_, i) => file(`Archivio/pratica-${i}/doc.pdf`));
    const text = describeSource({ ...analysis, entries, duplicates: { ...analysis.duplicates, groups: [] } });
    expect(text).toContain("di 401, le più interne sono omesse");
    expect(text).toContain("- Archivio | 400 file");
    expect(text.split("\n").length).toBeLessThan(160);
  });
});

describe("validateProposals", () => {
  it("accetta spostamenti, unioni, rinomine ed eliminazioni di duplicati applicabili", () => {
    const { proposals, discarded } = valid([
      { action: "move", from: "fatt_23", to: "Documenti/Fatture 2023", reason: "Sono documenti" },
      { action: "merge", from: "Scarica", to: "Documenti", reason: "Stesso tipo di file" },
      { action: "rename", from: "Vecchio", to: "Archivio", reason: "Nome più chiaro" },
      { action: "removeDuplicate", from: "Vecchio/Foto - Copia", to: "Foto", reason: "Copia identica" },
    ]);
    expect(proposals.map((p) => `${p.action} ${p.from} -> ${p.to}`)).toEqual([
      "move fatt_23 -> Documenti/Fatture 2023",
      "merge Scarica -> Documenti",
      "rename Vecchio -> Archivio",
      "removeDuplicate Vecchio/Foto - Copia -> Foto",
    ]);
    expect(discarded).toBe(0);
  });

  it("scarta le cartelle inventate e gli spostamenti impossibili", () => {
    const { proposals, discarded } = valid([
      { action: "move", from: "Inesistente", to: "Documenti/Altro", reason: "" },
      { action: "move", from: "Foto", to: "Foto/2024/Foto", reason: "dentro se stessa" },
      { action: "move", from: "Foto", to: "../Fuori", reason: "fuori dalla sorgente" },
      { action: "merge", from: "Foto", to: "Nuova cartella", reason: "la destinazione non esiste" },
      { action: "merge", from: "Foto", to: "Foto/2024", reason: "dentro una sua sottocartella" },
      { action: "rename", from: "Foto", to: "Documenti", reason: "nome già usato" },
      { action: "removeDuplicate", from: "Foto", to: "Documenti/contratto.pdf", reason: "non sono copie" },
      { action: "removeDuplicate", from: "fatt_23", to: "Foto", reason: "non è un duplicato" },
      { action: "delete", from: "Foto", to: "", reason: "azione sconosciuta" },
      "testo a caso",
    ]);
    expect(proposals).toEqual([]);
    expect(discarded).toBe(10);
  });

  it("tiene una sola proposta per cartella", () => {
    const { proposals, discarded } = valid([
      { action: "rename", from: "Vecchio", to: "Archivio", reason: "" },
      { action: "move", from: "Vecchio", to: "Documenti/Vecchio", reason: "" },
    ]);
    expect(proposals).toHaveLength(1);
    expect(discarded).toBe(1);
  });

  it("interpreta lo spostamento in una cartella esistente come 'mettila lì dentro'", () => {
    expect(valid([{ action: "move", from: "fatt_23", to: "Documenti", reason: "" }]).proposals[0].to).toBe("Documenti/fatt_23");
  });

  it("tratta come spostamento una rinomina che cambia posizione, e come nuovo nome una senza percorso", () => {
    const { proposals } = valid([
      { action: "rename", from: "fatt_23", to: "Documenti/Fatture 2023", reason: "" },
      { action: "rename", from: "Foto/2024", to: "Estate 2024", reason: "" },
    ]);
    expect(proposals.map((p) => `${p.action} ${p.to}`)).toEqual(["move Documenti/Fatture 2023", "rename Foto/Estate 2024"]);
  });

  it("non si rompe se il modello non restituisce un elenco", () => {
    expect(validateProposals(undefined, analysis)).toEqual({ proposals: [], discarded: 0 });
  });
});

describe("parseReply", () => {
  const body = '{"summary":"Tutto in ordine.","proposals":[{"action":"rename","from":"Vecchio","to":"Archivio","reason":"Più \\"chiaro\\" {così}"}]}';

  it("legge una risposta racchiusa in un blocco di codice o preceduta da un ragionamento", () => {
    for (const text of ["```json\n" + body + "\n```", "<think>Vediamo {le cartelle}…</think>\n" + body, "Ecco la proposta:\n" + body]) {
      const reply = parseReply(text);
      expect(reply.summary).toBe("Tutto in ordine.");
      expect(reply.proposals).toHaveLength(1);
    }
  });

  it("da una risposta a metà recupera il commento e le proposte complete, anche con graffe e virgolette nel testo", () => {
    const reply = parseReply(body.slice(0, -2) + ',{"action":"move","from":"Fo');
    expect(reply.summary).toBe("Tutto in ordine.");
    expect(reply.proposals).toEqual([{ action: "rename", from: "Vecchio", to: "Archivio", reason: 'Più "chiaro" {così}' }]);
  });

  it("rifiuta una risposta da cui non si ricava nulla, conservandone il testo", () => {
    expect(() => parseReply('{"summ')).toThrow(/Non è stato possibile leggere/);
    try {
      parseReply("solo testo");
    } catch (err) {
      expect((err as { raw: string }).raw).toBe("solo testo");
    }
  });
});

describe("Ollama", () => {
  let server: Server;
  let baseUrl: string;
  let lastRequest: { model: string; stream: boolean; think: boolean; format: unknown; options: { num_ctx: number }; messages: { role: string; content: string }[] };
  let chatReply: string[];

  beforeEach(async () => {
    chatReply = [];
    server = createServer((req, res) => {
      if (req.url === "/api/tags") {
        res.end(
          JSON.stringify({
            models: [
              { name: "gemma3:4b", size: 3_000_000_000, details: { family: "gemma3", parameter_size: "4.3B" } },
              { name: "nomic-embed-text:latest", size: 270_000_000, details: { family: "nomic-bert", parameter_size: "137M" } },
              { name: "gemma2:9b", size: 5_400_000_000, details: { family: "gemma2", parameter_size: "9.2B" } },
            ],
          })
        );
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        lastRequest = JSON.parse(body);
        res.end(chatReply.join("\n"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("elenca i modelli installati dal più grande, senza quelli di solo embedding", async () => {
    expect(await listModels(baseUrl)).toEqual([
      { name: "gemma2:9b", size: 5_400_000_000, parameterSize: "9.2B" },
      { name: "gemma3:4b", size: 3_000_000_000, parameterSize: "4.3B" },
    ]);
  });

  it("segnala Ollama assente invece di fallire", async () => {
    expect(await listModels("http://127.0.0.1:1")).toBeNull();
  });

  it("sceglie il modello più grande che sta in memoria, o il più piccolo se nessuno ci sta", async () => {
    const models = (await listModels(baseUrl))!;
    expect(pickDefaultModel(models, 16e9)).toBe("gemma2:9b");
    expect(pickDefaultModel(models, 8e9)).toBe("gemma3:4b");
    expect(pickDefaultModel(models, 2e9)).toBe("gemma3:4b");
    expect(pickDefaultModel([], 16e9)).toBeNull();
  });

  it("rispetta OLLAMA_HOST", () => {
    expect(ollamaBaseUrl({})).toBe("http://127.0.0.1:11434");
    expect(ollamaBaseUrl({ OLLAMA_HOST: "0.0.0.0:8080" })).toBe("http://127.0.0.1:8080");
    expect(ollamaBaseUrl({ OLLAMA_HOST: "http://localhost:9999/" })).toBe("http://localhost:9999");
  });

  it("ricompone la risposta arrivata a pezzi e tiene solo le proposte applicabili", async () => {
    const answer = JSON.stringify({
      summary: "Archivio con una cartella di foto copiata.",
      proposals: [
        { action: "removeDuplicate", from: "Vecchio/Foto - Copia", to: "Foto", reason: "Copia identica" },
        { action: "move", from: "Cartella inventata", to: "Altro", reason: "" },
      ],
    });
    chatReply = [answer.slice(0, 40), answer.slice(40)].map((content) => JSON.stringify({ message: { content }, done: false }));
    chatReply.push(JSON.stringify({ message: { content: "" }, done: true }));
    const written: number[] = [];

    const plan = await proposeReorganization(analysis, { baseUrl, model: "gemma2:9b", onText: (chars) => written.push(chars) });

    expect(plan).toEqual({
      model: "gemma2:9b",
      summary: "Archivio con una cartella di foto copiata.",
      proposals: [{ action: "removeDuplicate", from: "Vecchio/Foto - Copia", to: "Foto", reason: "Copia identica" }],
      discarded: 1,
      truncated: false,
    });
    expect(written[written.length - 1]).toBe(answer.length);
    expect(lastRequest.model).toBe("gemma2:9b");
    expect(lastRequest.stream).toBe(true);
    expect(lastRequest.think).toBe(false);
    expect(lastRequest.format).toMatchObject({ type: "object" });
    expect(lastRequest.options.num_ctx).toBeGreaterThanOrEqual(8192);
    expect(lastRequest.messages[1].content).toContain("Vecchio/Foto - Copia");
  });

  it("spiega quando il modello risponde con un testo libero o non risponde affatto", async () => {
    chatReply = [JSON.stringify({ message: { content: "Ecco cosa farei io." }, done: true })];
    await expect(proposeReorganization(analysis, { baseUrl, model: "gemma2:9b" })).rejects.toThrow(/testo libero/);
    chatReply = [JSON.stringify({ message: { content: "" }, done: true })];
    await expect(proposeReorganization(analysis, { baseUrl, model: "gemma2:9b" })).rejects.toThrow(/non ha scritto alcuna risposta/);
  });

  it("recupera le proposte arrivate intere da una risposta interrotta per mancanza di spazio", async () => {
    const cut = '{"summary":"Archivio disordinato.","proposals":[{"action":"merge","from":"Scarica","to":"Documenti","reason":"Stesso tipo"},{"action":"move","from":"fatt_23","to":"Docu';
    chatReply = [JSON.stringify({ message: { content: cut }, done: true, done_reason: "length" })];
    const plan = await proposeReorganization(analysis, { baseUrl, model: "gemma2:9b" });
    expect(plan.truncated).toBe(true);
    expect(plan.summary).toBe("Archivio disordinato.");
    expect(plan.proposals.map((p) => p.from)).toEqual(["Scarica"]);
  });

  it("riporta l'errore di Ollama, per esempio un modello non installato", async () => {
    chatReply = [JSON.stringify({ error: "model 'x' not found" })];
    await expect(proposeReorganization(analysis, { baseUrl, model: "x" })).rejects.toThrow(/model 'x' not found/);
  });
});
