import { parseUsdDecimal } from "./pinned-models";
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult, type FetchLike } from "./types";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Statuses where OpenRouter rejects the request before any generation is billed.
const DEFINITE_REJECTIONS = new Set([400, 401, 402, 403, 404, 413, 422, 429]);

interface CompletionBody {
  id?: unknown;
  model?: unknown;
  error?: unknown;
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
}

const intOrUndefined = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

/**
 * OpenRouter chat completions with exactly one HTTP attempt per call. The API key stays in
 * this object and is sent only in the Authorization header to OpenRouter.
 */
export class OpenRouterProvider implements ChatProvider {
  readonly mode = "live" as const;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;

  constructor(apiKey: string, fetchImpl: FetchLike = fetch, baseUrl: string = OPENROUTER_BASE_URL) {
    if (!apiKey) throw new Error("OpenRouter API key is required");
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#baseUrl = baseUrl;
  }

  async complete(request: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    const body = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxOutputTokens,
      temperature: 0.4,
      stream: false,
      usage: { include: true },
      provider: { max_price: { prompt: request.maxPrice.prompt, completion: request.maxPrice.completion } },
      ...(request.jsonObject ? { response_format: { type: "json_object" } } : {}),
    };
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          "x-title": "Veilo gateway (devnet demo)",
        },
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
    } catch (error) {
      // A timeout or connection failure may happen after the request was accepted upstream.
      throw new ProviderError("ambiguous", `provider request did not complete: ${(error as Error).name}`);
    }
    if (DEFINITE_REJECTIONS.has(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError("definite", `provider rejected the request (HTTP ${response.status})`, response.status);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError("ambiguous", `provider returned HTTP ${response.status}`, response.status);
    }
    let parsed: CompletionBody;
    try {
      parsed = (await response.json()) as CompletionBody;
    } catch {
      throw new ProviderError("ambiguous", "provider response was not readable JSON", response.status);
    }
    const content = parsed.choices?.[0]?.message?.content;
    if (parsed.error !== undefined || typeof content !== "string") {
      throw new ProviderError("ambiguous", "provider response carried no completion", response.status);
    }
    const finish = parsed.choices?.[0]?.finish_reason;
    return {
      text: content,
      httpStatus: response.status,
      reportedModel: typeof parsed.model === "string" ? parsed.model : undefined,
      generationId: typeof parsed.id === "string" ? parsed.id : undefined,
      finishReason: typeof finish === "string" ? finish : undefined,
      promptTokens: intOrUndefined(parsed.usage?.prompt_tokens),
      completionTokens: intOrUndefined(parsed.usage?.completion_tokens),
      costMicro: parseUsdDecimal(parsed.usage?.cost, 6),
    };
  }

  /**
   * Reads the key's own spend limit (no generation, no charge). Returns remaining micro-USD
   * when the key has a limit, `null` when it is unlimited.
   */
  async keyLimitRemainingMicro(signal: AbortSignal): Promise<bigint | null> {
    const response = await this.#fetch(`${this.#baseUrl}/key`, {
      headers: { authorization: `Bearer ${this.#apiKey}` },
      signal,
      redirect: "error",
    });
    if (!response.ok) throw new ProviderError("definite", `key status HTTP ${response.status}`, response.status);
    const body = (await response.json()) as { data?: { limit_remaining?: unknown; limit?: unknown } };
    if (body.data?.limit === null || body.data?.limit_remaining === null) return null;
    const remaining = parseUsdDecimal(body.data?.limit_remaining, 6);
    if (remaining === undefined) throw new ProviderError("definite", "key status response was malformed");
    return remaining;
  }
}
