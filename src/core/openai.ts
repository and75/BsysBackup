import { AiError, httpFailure, serverEvents, unreachable, type AiAccess, type AiReply, type AiRequest } from "./ai";
import type { AiModel } from "./types";

const SERVICE = "OpenAI";
const DEFAULT_URL = "https://api.openai.com/v1";

const baseUrl = (access: AiAccess) => (access.baseUrl ?? DEFAULT_URL).replace(/\/+$/, "");
const headers = (access: AiAccess) => ({ Authorization: `Bearer ${access.apiKey}`, "Content-Type": "application/json" });

async function request(access: AiAccess, path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl(access)}${path}`, { ...init, headers: headers(access) });
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
    throw httpFailure(SERVICE, res.status, detail);
  }
  return res;
}

/** I modelli di testo disponibili per questa chiave, dal più recente: l'elenco comprende anche audio, immagini ed embedding, che qui non servono */
export async function listOpenAiModels(access: AiAccess): Promise<AiModel[]> {
  const res = await request(access, "/models", { method: "GET", signal: AbortSignal.timeout(15_000) });
  const reply = (await res.json()) as { data?: { id: string; created?: number }[] };
  return (reply.data ?? [])
    .filter((m) => /^(gpt-|chatgpt-|o\d)/.test(m.id) && !/audio|realtime|tts|transcribe|image|embedding|search|instruct|moderation/.test(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id))
    .map((m) => ({ name: m.id, size: 0, parameterSize: "" }));
}

interface ChatChunk {
  error?: { message?: string };
  choices?: { delta?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
}

export async function askOpenAi(access: AiAccess, req: AiRequest): Promise<AiReply> {
  const res = await request(access, "/chat/completions", {
    method: "POST",
    signal: req.signal,
    body: JSON.stringify({
      model: req.model,
      stream: true,
      response_format: { type: "json_schema", json_schema: { name: "risposta", strict: true, schema: req.schema } },
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    }),
  });

  let text = "";
  let refusal = "";
  let truncated = false;
  for await (const data of serverEvents(res)) {
    if (data === "[DONE]" || data === "") continue;
    const chunk = JSON.parse(data) as ChatChunk;
    if (chunk.error) throw new AiError(`${SERVICE}: ${chunk.error.message ?? "errore durante la risposta"}`);
    const choice = chunk.choices?.[0];
    text += choice?.delta?.content ?? "";
    refusal += choice?.delta?.refusal ?? "";
    if (choice?.finish_reason === "length") truncated = true;
    req.onText?.(text.length);
  }
  if (text === "" && refusal !== "") throw new AiError("Il modello ha declinato la richiesta. Riprova, oppure scegli un altro modello.");
  return { text, truncated };
}
