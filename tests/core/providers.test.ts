import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { askProvider, listProviderModels, type AiRequest } from "../../src/core/ai";

/** Finto servizio: risponde a ogni richiesta con ciò che decide il test, e ricorda cosa ha ricevuto */
let server: Server;
let baseUrl: string;
let received: { method: string; url: string; headers: IncomingMessage["headers"]; body: any }[];
let respond: (req: (typeof received)[number], res: ServerResponse) => void;

const request: AiRequest = {
  model: "modello-di-prova",
  system: "Sei un assistente.",
  prompt: "Cartelle (1):\n- Foto | 2 file",
  schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
};
const answer = '{"summary":"Tutto in ordine."}';
const events = (items: unknown[]) => items.map((item) => `data: ${typeof item === "string" ? item : JSON.stringify(item)}\n\n`).join("");
const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

beforeEach(async () => {
  received = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: body ? JSON.parse(body) : null };
      received.push(entry);
      respond(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("OpenAI", () => {
  const access = () => ({ apiKey: "sk-prova", baseUrl });

  it("elenca solo i modelli di testo, dal più recente", async () => {
    respond = (_req, res) =>
      json(res, 200, {
        data: [
          { id: "gpt-4o", created: 100 },
          { id: "text-embedding-3-large", created: 300 },
          { id: "gpt-5", created: 200 },
          { id: "gpt-4o-audio-preview", created: 400 },
          { id: "o3", created: 150 },
        ],
      });
    expect((await listProviderModels("openai", access()))!.map((m) => m.name)).toEqual(["gpt-5", "o3", "gpt-4o"]);
    expect(received[0].headers.authorization).toBe("Bearer sk-prova");
  });

  it("chiede una risposta secondo lo schema e la ricompone dai pezzi", async () => {
    respond = (_req, res) =>
      res.end(events([{ choices: [{ delta: { content: answer.slice(0, 10) } }] }, { choices: [{ delta: { content: answer.slice(10) } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]));
    const written: number[] = [];
    const reply = await askProvider("openai", access(), { ...request, onText: (chars) => written.push(chars) });
    expect(reply).toEqual({ text: answer, truncated: false });
    expect(written[written.length - 1]).toBe(answer.length);
    const { body, url } = received[0];
    expect(url).toBe("/chat/completions");
    expect(body.model).toBe("modello-di-prova");
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true, schema: request.schema } });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
  });

  it("segnala la risposta interrotta per mancanza di spazio", async () => {
    respond = (_req, res) => res.end(events([{ choices: [{ delta: { content: '{"summ' }, finish_reason: "length" }] }, "[DONE]"]));
    expect((await askProvider("openai", access(), request)).truncated).toBe(true);
  });

  it("spiega una chiave non valida e un limite raggiunto", async () => {
    respond = (_req, res) => json(res, 401, { error: { message: "Incorrect API key provided" } });
    await expect(listProviderModels("openai", access())).rejects.toThrow(/non accetta la chiave API/);
    respond = (_req, res) => json(res, 429, { error: { message: "You exceeded your current quota" } });
    await expect(askProvider("openai", access(), request)).rejects.toThrow(/limite di richieste o il credito/);
  });
});

describe("Google", () => {
  const access = () => ({ apiKey: "chiave-google", baseUrl });

  it("elenca solo i modelli Gemini che generano testo", async () => {
    respond = (_req, res) =>
      json(res, 200, {
        models: [
          { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-10-pro", displayName: "Gemini 10 Pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
        ],
      });
    expect(await listProviderModels("google", access())).toEqual([
      { name: "gemini-10-pro", label: "Gemini 10 Pro", size: 0, parameterSize: "" },
      { name: "gemini-2.5-flash", label: "Gemini 2.5 Flash", size: 0, parameterSize: "" },
    ]);
    expect(received[0].headers["x-goog-api-key"]).toBe("chiave-google");
    expect(received[0].url).not.toContain("chiave-google");
  });

  it("chiede una risposta in JSON, toglie dallo schema ciò che Gemini non accetta e ignora il ragionamento", async () => {
    respond = (_req, res) =>
      res.end(
        events([
          { candidates: [{ content: { parts: [{ text: "ragiono…", thought: true }, { text: answer.slice(0, 12) }] } }] },
          { candidates: [{ content: { parts: [{ text: answer.slice(12) }] }, finishReason: "STOP" }] },
        ])
      );
    expect(await askProvider("google", access(), request)).toEqual({ text: answer, truncated: false });
    const { body, url } = received[0];
    expect(url).toBe("/models/modello-di-prova:streamGenerateContent?alt=sse");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual({ type: "object", properties: { summary: { type: "string" } }, required: ["summary"] });
    expect(body.systemInstruction.parts[0].text).toBe("Sei un assistente.");
  });

  it("riconosce la chiave non valida anche se Google risponde 400", async () => {
    respond = (_req, res) => json(res, 400, { error: { message: "API key not valid. Please pass a valid API key." } });
    await expect(listProviderModels("google", access())).rejects.toThrow(/non accetta la chiave API/);
  });

  it("spiega quando la richiesta viene bloccata", async () => {
    respond = (_req, res) => res.end(events([{ promptFeedback: { blockReason: "SAFETY" } }]));
    await expect(askProvider("google", access(), request)).rejects.toThrow(/ha declinato la richiesta/);
  });
});

describe("Anthropic", () => {
  const access = () => ({ apiKey: "sk-ant-prova", baseUrl });
  const stream = (text: string, stopReason: string) =>
    [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 10) } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(10) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");

  it("elenca i modelli che sanno rispondere secondo uno schema", async () => {
    respond = (_req, res) =>
      json(res, 200, {
        data: [
          { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", type: "model", capabilities: { structured_outputs: { supported: true } } },
          { id: "claude-vecchio", display_name: "Claude Vecchio", type: "model", capabilities: { structured_outputs: { supported: false } } },
        ],
        has_more: false,
        first_id: "claude-opus-5-5",
        last_id: "claude-vecchio",
      });
    expect(await listProviderModels("anthropic", access())).toEqual([{ name: "claude-opus-5-5", label: "Claude Opus 5.5", size: 0, parameterSize: "" }]);
    // L'SDK decide in quale intestazione mandare la chiave: conta che arrivi
    expect([received[0].headers["x-api-key"], received[0].headers.authorization]).toContain("sk-ant-prova".replace(/^/, received[0].headers.authorization ? "Bearer " : ""));
  });

  it("chiede la risposta secondo lo schema, con il ripiego automatico sui modelli che lo prevedono", async () => {
    respond = (_req, res) => res.writeHead(200, { "Content-Type": "text/event-stream" }).end(stream(answer, "end_turn"));
    const written: number[] = [];
    const reply = await askProvider("anthropic", access(), { ...request, model: "claude-opus-5-5", onText: (chars) => written.push(chars) });
    expect(reply).toEqual({ text: answer, truncated: false });
    expect(written[written.length - 1]).toBe(answer.length);
    const { body, headers } = received[0];
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.stream).toBe(true);
    expect(body.output_config.format).toEqual({ type: "json_schema", schema: request.schema });
    expect(body.fallbacks).toBe("default");
    expect(headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(body.thinking).toBeUndefined();
  });

  it("non chiede il ripiego ai modelli che lo rifiuterebbero", async () => {
    respond = (_req, res) => res.writeHead(200, { "Content-Type": "text/event-stream" }).end(stream(answer, "end_turn"));
    await askProvider("anthropic", access(), { ...request, model: "claude-haiku-5-5" });
    expect(received[0].body.fallbacks).toBeUndefined();
    expect(received[0].headers["anthropic-beta"] ?? "").not.toContain("server-side-fallback");
  });

  it("spiega una richiesta declinata e una chiave non valida", async () => {
    respond = (_req, res) => res.writeHead(200, { "Content-Type": "text/event-stream" }).end(stream("", "refusal"));
    await expect(askProvider("anthropic", access(), { ...request, model: "claude-opus-5-5" })).rejects.toThrow(/ha declinato la richiesta/);
    respond = (_req, res) => json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    await expect(askProvider("anthropic", access(), { ...request, model: "claude-opus-5-5" })).rejects.toThrow(/non accetta la chiave API/);
  });
});

describe("senza chiave", () => {
  it("un servizio cloud non elenca modelli e spiega cosa manca", async () => {
    expect(await listProviderModels("openai", null)).toBeNull();
    await expect(askProvider("google", null, request)).rejects.toThrow(/Manca la chiave API/);
  });
});
