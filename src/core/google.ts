import { AiError, httpFailure, serverEvents, unreachable, type AiAccess, type AiReply, type AiRequest } from "./ai";
import type { AiModel } from "./types";

const SERVICE = "Google";
const DEFAULT_URL = "https://generativelanguage.googleapis.com/v1beta";

const baseUrl = (access: AiAccess) => (access.baseUrl ?? DEFAULT_URL).replace(/\/+$/, "");

async function request(access: AiAccess, path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    // La chiave va in un'intestazione, non nell'indirizzo, così non finisce in registri e messaggi d'errore
    res = await fetch(`${baseUrl(access)}${path}`, { ...init, headers: { "x-goog-api-key": access.apiKey, "Content-Type": "application/json" } });
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw unreachable(SERVICE);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = "";
    try {
      detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? "";
    } catch {}
    // Google risponde 400, non 401, a una chiave inesistente
    throw httpFailure(SERVICE, res.status === 400 && /API key/i.test(detail) ? 401 : res.status, detail);
  }
  return res;
}

/** I modelli Gemini che generano testo, dal nome più recente: l'elenco comprende anche embedding, immagini e voce */
export async function listGoogleModels(access: AiAccess): Promise<AiModel[]> {
  const res = await request(access, "/models?pageSize=200", { method: "GET", signal: AbortSignal.timeout(15_000) });
  const reply = (await res.json()) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
  return (reply.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /gemini/.test(m.name) && !/embedding|image|tts|audio|live|aqa/.test(m.name))
    .map((m) => ({ name: m.name.replace(/^models\//, ""), label: m.displayName, size: 0, parameterSize: "" }))
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
}

/** Lo schema accettato da Gemini non conosce "additionalProperties": va tolto a ogni livello */
function forGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(forGemini);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== "additionalProperties")
      .map(([key, value]) => [key, forGemini(value)])
  );
}

interface GenerateChunk {
  error?: { message?: string };
  promptFeedback?: { blockReason?: string };
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
}

export async function askGoogle(access: AiAccess, req: AiRequest): Promise<AiReply> {
  const res = await request(access, `/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`, {
    method: "POST",
    signal: req.signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: forGemini(req.schema) },
    }),
  });

  let text = "";
  let truncated = false;
  let blocked = false;
  for await (const data of serverEvents(res)) {
    if (data === "") continue;
    const chunk = JSON.parse(data) as GenerateChunk;
    if (chunk.error) throw new AiError(`${SERVICE}: ${chunk.error.message ?? "errore durante la risposta"}`);
    if (chunk.promptFeedback?.blockReason) blocked = true;
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) if (!part.thought) text += part.text ?? "";
    if (candidate?.finishReason === "MAX_TOKENS") truncated = true;
    if (candidate?.finishReason === "SAFETY" || candidate?.finishReason === "PROHIBITED_CONTENT") blocked = true;
    req.onText?.(text.length);
  }
  if (text === "" && blocked) throw new AiError("Il modello ha declinato la richiesta. Riprova, oppure scegli un altro modello.");
  return { text, truncated };
}
