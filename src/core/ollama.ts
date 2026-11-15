import type { AiModel } from "./types";

const DEFAULT_URL = "http://127.0.0.1:11434";
const STATUS_TIMEOUT_MS = 3000;

/** Indirizzo di Ollama su questo computer; rispetta OLLAMA_HOST, la stessa variabile che usa Ollama */
export function ollamaBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.OLLAMA_HOST?.trim();
  if (!host) return DEFAULT_URL;
  const url = /^https?:\/\//.test(host) ? host : `http://${host}`;
  // 0.0.0.0 è un indirizzo su cui ascoltare, non uno a cui collegarsi
  return url.replace("//0.0.0.0", "//127.0.0.1").replace(/\/+$/, "");
}

interface TagsReply {
  models?: { name: string; size?: number; details?: { family?: string; parameter_size?: string } }[];
}

/** I modelli installati, dal più grande. null se Ollama non risponde. */
export async function listModels(baseUrl: string): Promise<AiModel[] | null> {
  let reply: TagsReply;
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!res.ok) return null;
    reply = (await res.json()) as TagsReply;
  } catch {
    return null;
  }
  return (reply.models ?? [])
    // I modelli di embedding non generano testo: non servono a proporre una riorganizzazione
    .filter((m) => !/embed/i.test(m.name) && !/bert/i.test(m.details?.family ?? ""))
    .map((m) => ({ name: m.name, size: m.size ?? 0, parameterSize: m.details?.parameter_size ?? "" }))
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
}

/** Il modello più grande che sta comodo nella memoria del computer; se nessuno ci sta, il più piccolo */
export function pickDefaultModel(models: AiModel[], totalMemory: number): string | null {
  if (models.length === 0) return null;
  const fitting = models.filter((m) => m.size <= totalMemory * 0.6);
  return (fitting[0] ?? models[models.length - 1]).name;
}

export interface ChatRequest {
  model: string;
  system: string;
  prompt: string;
  /** Schema JSON a cui la risposta deve attenersi */
  schema: object;
  /** Ampiezza del contesto: quella predefinita di Ollama taglierebbe in silenzio un elenco lungo */
  contextTokens: number;
  signal?: AbortSignal;
  /** Chiamata man mano che il modello scrive, con il numero di caratteri prodotti finora */
  onText?: (chars: number) => void;
}

/**
 * Chiede al modello una risposta in JSON e ne restituisce il testo; `truncated` dice se si è
 * interrotta per aver esaurito lo spazio a disposizione.
 * La risposta arriva a pezzi: così la richiesta non scade mentre un modello lento sta ancora scrivendo.
 */
export async function chatJson(baseUrl: string, req: ChatRequest): Promise<{ text: string; truncated: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        stream: true,
        format: req.schema,
        // I modelli che "ragionano" prima di rispondere consumerebbero lì tutto lo spazio, lasciando la risposta a metà
        think: false,
        options: { temperature: 0.2, num_ctx: req.contextTokens },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
      }),
    });
  } catch (err) {
    if (req.signal?.aborted) throw err;
    throw new Error("Ollama non risponde: controlla che sia in esecuzione.");
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    let message = detail;
    try {
      message = (JSON.parse(detail) as { error?: string }).error ?? detail;
    } catch {}
    throw new Error(`Ollama ha rifiutato la richiesta: ${message || res.status}`);
  }

  let content = "";
  let written = 0;
  let truncated = false;
  let pending = "";
  const decoder = new TextDecoder();
  const take = (line: string) => {
    if (!line.trim()) return;
    const part = JSON.parse(line) as { error?: string; done_reason?: string; message?: { content?: string; thinking?: string } };
    if (part.error) throw new Error(`Ollama: ${part.error}`);
    if (part.done_reason === "length") truncated = true;
    content += part.message?.content ?? "";
    written += (part.message?.content ?? "").length + (part.message?.thinking ?? "").length;
    req.onText?.(written);
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    lines.forEach(take);
  }
  take(pending);
  return { text: content, truncated };
}
