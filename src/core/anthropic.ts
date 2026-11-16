import Anthropic from "@anthropic-ai/sdk";
import { AiError, httpFailure, unreachable, type AiAccess, type AiReply, type AiRequest } from "./ai";
import type { AiModel } from "./types";

const SERVICE = "Anthropic";
/** Modello proposto se l'utente non ne ha scelto uno */
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";
/** La risposta arriva a pezzi, quindi il limite può essere ampio: comprende anche il ragionamento del modello */
const MAX_TOKENS = 64000;
/**
 * Modelli per cui, se la richiesta viene declinata dai controlli di sicurezza, il servizio può
 * riprovare da solo con un altro modello. Gli altri modelli rifiuterebbero il parametro.
 */
const SERVER_FALLBACK_MODELS = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

function client(access: AiAccess): Anthropic {
  return new Anthropic({ apiKey: access.apiKey, baseURL: access.baseUrl });
}

function failure(err: unknown): Error {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.APIConnectionError) return unreachable(SERVICE);
  if (err instanceof Anthropic.APIError && typeof err.status === "number") return httpFailure(SERVICE, err.status, err.message);
  return err instanceof Error ? err : new Error(String(err));
}

/** I modelli di Claude disponibili per questa chiave che sanno rispondere secondo uno schema, dal più recente */
export async function listAnthropicModels(access: AiAccess): Promise<AiModel[]> {
  const models: AiModel[] = [];
  try {
    for await (const model of client(access).models.list()) {
      if (model.capabilities && !model.capabilities.structured_outputs.supported) continue;
      models.push({ name: model.id, label: model.display_name, size: 0, parameterSize: "" });
    }
  } catch (err) {
    throw failure(err);
  }
  return models;
}

export async function askAnthropic(access: AiAccess, req: AiRequest): Promise<AiReply> {
  try {
    // "thinking" non viene indicato: i modelli attuali ragionano comunque quanto serve, e quelli
    // precedenti accettano la richiesta senza ragionare. Nessun'altra impostazione vale per tutti.
    const stream = client(access).beta.messages.stream(
      {
        model: req.model,
        max_tokens: MAX_TOKENS,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: { format: { type: "json_schema", schema: req.schema } },
        ...(SERVER_FALLBACK_MODELS.has(req.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: req.signal }
    );
    stream.on("text", (_delta, snapshot) => req.onText?.(snapshot.length));
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      throw new AiError("Il modello ha declinato la richiesta per motivi di sicurezza. Riprova, oppure scegli un altro modello.");
    }
    let text = "";
    for (const block of message.content) if (block.type === "text") text += block.text;
    return { text, truncated: message.stop_reason === "max_tokens" };
  } catch (err) {
    if (req.signal?.aborted) throw err;
    throw failure(err);
  }
}
