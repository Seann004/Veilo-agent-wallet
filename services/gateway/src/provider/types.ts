import type { ChatMessage } from "./token-bound";

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  jsonObject: boolean;
  /** USD per million tokens; the provider must not route above these rates. */
  maxPrice: { prompt: number; completion: number };
  /** Ask the provider to answer without reasoning (see PinnedModel.reasoning). */
  disableReasoning?: boolean;
}

export interface ChatResult {
  text: string;
  httpStatus: number;
  reportedModel: string | undefined;
  generationId: string | undefined;
  finishReason: string | undefined;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  /** Provider-reported cost in micro-USD (rounded up), when reported. */
  costMicro: bigint | undefined;
}

/**
 * `definite`: the provider proved the request was not executed (no generation, no charge
 * expected). `ambiguous`: the request may have run; the outcome is unknown.
 */
export class ProviderError extends Error {
  readonly kind: "definite" | "ambiguous";
  readonly httpStatus: number | undefined;

  constructor(kind: "definite" | "ambiguous", message: string, httpStatus?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

export interface ChatProvider {
  /** `fixture` providers exist only in automated tests and never pass real-inference acceptance. */
  readonly mode: "live" | "fixture";
  complete(request: ChatRequest, signal: AbortSignal): Promise<ChatResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
