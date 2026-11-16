import { askAnthropic, listAnthropicModels } from "./anthropic";
import { askGoogle, listGoogleModels } from "./google";
import { chatJson, listModels, ollamaBaseUrl } from "./ollama";
import { askOpenAi, listOpenAiModels } from "./openai";
import type { AiModel, AiProvider } from "./types";

/** Ampiezza del contesto chiesta a Ollama: quella predefinita taglierebbe in silenzio un elenco lungo */
const OLLAMA_CONTEXT_TOKENS = 8192;

/** Una richiesta a un modello, uguale per tutti i fornitori: una domanda, una risposta in JSON */
export interface AiRequest {
  model: string;
  system: string;
  prompt: string;
  /** Schema JSON a cui la risposta deve attenersi */
  schema: Record<string, unknown>;
  signal?: AbortSignal;
  /** Chiamata man mano che il modello scrive, con il numero di caratteri prodotti finora */
  onText?: (chars: number) => void;
}

export interface AiReply {
  text: string;
  /** true se il modello si è interrotto per aver esaurito lo spazio a disposizione */
  truncated: boolean;
}

/** Come raggiungere un fornitore cloud */
export interface AiAccess {
  apiKey: string;
  /** Indirizzo alternativo del servizio, al posto di quello ufficiale */
  baseUrl?: string;
}

export const CLOUD_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

export function isCloud(provider: AiProvider): provider is CloudProvider {
  return provider !== "ollama";
}

/** Variabili d'ambiente da cui leggere chiave e indirizzo, le stesse usate dagli strumenti ufficiali di ogni fornitore */
export const PROVIDER_ENV: Record<CloudProvider, { key: string[]; baseUrl: string }> = {
  anthropic: { key: ["ANTHROPIC_API_KEY"], baseUrl: "ANTHROPIC_BASE_URL" },
  openai: { key: ["OPENAI_API_KEY"], baseUrl: "OPENAI_BASE_URL" },
  google: { key: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], baseUrl: "GOOGLE_GEMINI_BASE_URL" },
};

/** Un errore il cui messaggio è già adatto a essere mostrato all'utente */
export class AiError extends Error {}

/** Traduce l'esito di una richiesta non riuscita in un messaggio che dica cosa fare */
export function httpFailure(service: string, status: number, detail: string): AiError {
  if (status === 401 || status === 403) return new AiError(`${service} non accetta la chiave API: controlla che sia corretta e attiva.`);
  if (status === 404) return new AiError(`${service} non riconosce il modello scelto: selezionane un altro.`);
  if (status === 429) return new AiError(`${service} ha raggiunto il limite di richieste o il credito disponibile. Riprova più tardi o controlla il tuo account.`);
  return new AiError(`${service} ha risposto con un errore (${status})${detail ? `: ${detail}` : "."}`);
}

export function unreachable(service: string): AiError {
  return new AiError(`Impossibile raggiungere ${service}: controlla la connessione a Internet.`);
}

/** Legge una risposta a eventi (SSE) e ne restituisce, uno alla volta, i dati di ogni evento */
export async function* serverEvents(res: Response): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith("data:")) yield line.slice(5).trim();
  }
  if (pending.startsWith("data:")) yield pending.slice(5).trim();
}

/** I modelli utilizzabili di un fornitore. Per Ollama, null se non è in esecuzione. */
export async function listProviderModels(provider: AiProvider, access: AiAccess | null): Promise<AiModel[] | null> {
  if (provider === "ollama") return listModels(ollamaBaseUrl());
  if (!access) return null;
  if (provider === "anthropic") return listAnthropicModels(access);
  if (provider === "openai") return listOpenAiModels(access);
  return listGoogleModels(access);
}

export async function askProvider(provider: AiProvider, access: AiAccess | null, req: AiRequest): Promise<AiReply> {
  if (provider === "ollama") return chatJson(ollamaBaseUrl(), { ...req, contextTokens: OLLAMA_CONTEXT_TOKENS });
  if (!access) throw new AiError("Manca la chiave API: inseriscila nelle Impostazioni.");
  if (provider === "anthropic") return askAnthropic(access, req);
  if (provider === "openai") return askOpenAi(access, req);
  return askGoogle(access, req);
}
