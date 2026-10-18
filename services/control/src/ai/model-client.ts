import type { PromptMessage } from "@veilo/contracts/gateway";

export type AiProviderKind = "openrouter" | "anthropic" | "openai" | "openai_compatible";

export const DEFAULT_BASE_URL: Record<Exclude<AiProviderKind, "openai_compatible">, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
};

export interface ModelEndpoint {
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ModelCompletion {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** A refusal before generation (bad key, unknown model, rate limit) versus an unknown outcome. */
export class ModelCallError extends Error {
  constructor(
    readonly kind: "rejected" | "unavailable",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * One chat completion on the owner's provider, one HTTP attempt, no redirects. OpenRouter,
 * OpenAI and any OpenAI-compatible endpoint share the chat completions API; Anthropic uses its
 * Messages API. The key is sent only in the provider's own auth header.
 */
/** One inline image for a multimodal call; it is attached to the last user message only. */
export interface ModelImage {
  mime: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
}

const anthropicImageContent = (text: string, img: ModelImage) => [
  { type: "image", source: { type: "base64", media_type: img.mime, data: img.base64 } },
  { type: "text", text },
];

function withOpenAiImage(messages: readonly PromptMessage[], img: ModelImage): unknown[] {
  let last = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") last = i;
  });
  return messages.map((m, i) =>
    i === last ? { role: "user", content: [{ type: "text", text: m.content }, { type: "image_url", image_url: { url: `data:${img.mime};base64,${img.base64}` } }] } : m,
  );
}

/** Z.ai's GLM API; its models think by default unless the request turns thinking off. */
const ZAI_HOSTS = new Set(["api.z.ai", "open.bigmodel.cn"]);

export async function completeWithProvider(
  e: ModelEndpoint,
  messages: readonly PromptMessage[],
  o: { maxOutputTokens: number; json?: boolean; timeoutMs?: number; fetch?: FetchLike; noThinking?: boolean; image?: ModelImage },
): Promise<ModelCompletion> {
  const fetchImpl = o.fetch ?? ((u, i) => fetch(u, i));
  const base = e.baseUrl.replace(/\/$/, "");
  const anthropic = e.provider === "anthropic";
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const url = anthropic ? `${base}/messages` : `${base}/chat/completions`;
  const headers: Record<string, string> = anthropic
    ? { "x-api-key": e.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }
    : { authorization: `Bearer ${e.apiKey}`, "content-type": "application/json", ...(e.provider === "openrouter" ? { "x-title": "Veilo" } : {}) };
  const users = messages.filter((m) => m.role === "user");
  const lastUser = users.length - 1;
  const body = anthropic
    ? {
        model: e.model,
        max_tokens: o.maxOutputTokens,
        ...(system ? { system } : {}),
        messages: users.map((m, i) => ({ role: "user", content: o.image && i === lastUser ? anthropicImageContent(m.content, o.image) : m.content })),
      }
    : {
        model: e.model,
        max_tokens: o.maxOutputTokens,
        temperature: 0.4,
        messages: o.image ? withOpenAiImage(messages, o.image) : messages,
        ...(o.json ? { response_format: { type: "json_object" } } : {}),
        // Thinking spends the output budget before any answer; short structured calls skip it.
        ...(o.noThinking && ZAI_HOSTS.has(new URL(base).hostname) ? { thinking: { type: "disabled" } } : {}),
      };
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 60_000) });
  } catch (error) {
    throw new ModelCallError("unavailable", `model provider unreachable (${(error as Error).name})`);
  }
  const text = await res.text();
  if (!res.ok) {
    const rejected = [400, 401, 402, 403, 404, 413, 422, 429].includes(res.status);
    throw new ModelCallError(rejected ? "rejected" : "unavailable", `model provider returned HTTP ${res.status}`, res.status);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ModelCallError("unavailable", "model provider returned unreadable JSON", res.status);
  }
  if (anthropic) {
    const parts = Array.isArray(parsed.content) ? (parsed.content as Array<{ type?: unknown; text?: unknown }>) : [];
    const out = parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text as string).join("");
    if (!out) throw new ModelCallError("unavailable", "model provider returned no text", res.status);
    const usage = parsed.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
    return { text: out, model: typeof parsed.model === "string" ? parsed.model : e.model, inputTokens: int(usage?.input_tokens), outputTokens: int(usage?.output_tokens) };
  }
  const choice = (parsed.choices as Array<{ message?: { content?: unknown }; finish_reason?: unknown }> | undefined)?.[0];
  if (typeof choice?.message?.content !== "string" || choice.message.content === "") {
    const cut = choice?.finish_reason === "length";
    throw new ModelCallError("unavailable", cut ? "the model used its whole output budget before answering (reasoning models need more)" : "model provider returned no completion", res.status);
  }
  const usage = parsed.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
  return { text: choice.message.content, model: typeof parsed.model === "string" ? parsed.model : e.model, inputTokens: int(usage?.prompt_tokens), outputTokens: int(usage?.completion_tokens) };
}

/**
 * The provider's own model list (no generation, no charge). OpenRouter, OpenAI and compatible
 * APIs answer GET /models; Anthropic answers GET /v1/models with its own auth header.
 */
export async function listProviderModels(e: Omit<ModelEndpoint, "model">, o: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<string[]> {
  const fetchImpl = o.fetch ?? ((u, i) => fetch(u, i));
  const anthropic = e.provider === "anthropic";
  const headers: Record<string, string> = anthropic ? { "x-api-key": e.apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${e.apiKey}` };
  let res: Response;
  try {
    res = await fetchImpl(`${e.baseUrl.replace(/\/$/, "")}/models`, { headers, redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
  } catch (error) {
    throw new ModelCallError("unavailable", `model provider unreachable (${(error as Error).name})`);
  }
  if (!res.ok) throw new ModelCallError([401, 403].includes(res.status) ? "rejected" : "unavailable", `model list returned HTTP ${res.status}`, res.status);
  const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
  const ids = (body?.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9._:/@-]{1,200}$/.test(id));
  return [...new Set(ids)].sort().slice(0, 500);
}
