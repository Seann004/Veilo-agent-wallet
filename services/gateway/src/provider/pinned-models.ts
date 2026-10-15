/**
 * Allowlisted upstream models with their pinned tariffs. Prices are integer pico-USD per
 * token (1 USD = 10^12 pico-USD), copied from OpenRouter's public models endpoint at
 * `pinnedAt`. Before every call the gateway re-reads live pricing and refuses to dispatch
 * if it is stale or higher than the pin; requests also carry `provider.max_price` at the
 * pinned rate so routing cannot pick a more expensive provider.
 */
export interface PinnedModel {
  id: string;
  promptPicoPerToken: bigint;
  completionPicoPerToken: bigint;
  requestPico: bigint;
  contextLength: number;
  maxCompletionTokens: number;
  /** Tokenizer family; all pinned models use byte-level BPE (see token-bound.ts). */
  tokenizer: string;
  pinnedAt: string;
  source: string;
}

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export const PINNED_MODELS: Readonly<Record<string, PinnedModel>> = {
  "mistralai/mistral-nemo": {
    id: "mistralai/mistral-nemo",
    promptPicoPerToken: 29_000n,
    completionPicoPerToken: 30_000n,
    requestPico: 0n,
    contextLength: 131_072,
    maxCompletionTokens: 16_384,
    tokenizer: "Mistral (Tekken, byte-level BPE)",
    pinnedAt: "2026-10-14T14:08:19Z",
    source: OPENROUTER_MODELS_URL,
  },
};

export function pinnedModel(id: string | undefined): PinnedModel | undefined {
  return id === undefined ? undefined : PINNED_MODELS[id];
}

const PICO_PER_MICRO = 1_000_000n;

/** Worst-case cost in micro-USD, rounded up. */
export function worstCaseMicroUsd(model: PinnedModel, inputTokens: number, outputTokens: number): bigint {
  const pico =
    BigInt(inputTokens) * model.promptPicoPerToken +
    BigInt(outputTokens) * model.completionPicoPerToken +
    model.requestPico;
  return (pico + PICO_PER_MICRO - 1n) / PICO_PER_MICRO;
}

/** Pinned per-token price as OpenRouter's `max_price` value (USD per million tokens). */
export function usdPerMillion(picoPerToken: bigint): number {
  // pico/token * 1e6 tokens / 1e12 = pico / 1e6 USD; exact for the pinned integer values.
  return Number(picoPerToken) / 1_000_000;
}

/**
 * Parses a non-negative decimal USD string into integer units of 10^-scale USD, rounding up.
 * Returns undefined for anything that is not a plain decimal.
 */
export function parseUsdDecimal(value: unknown, scale: number): bigint | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) value = value.toFixed(15);
  if (typeof value !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(value)) return undefined;
  const [whole = "0", frac = ""] = value.split(".");
  const head = frac.slice(0, scale).padEnd(scale, "0");
  const rest = frac.slice(scale);
  let units = BigInt(whole) * 10n ** BigInt(scale) + BigInt(head === "" ? "0" : head);
  if (/[1-9]/.test(rest)) units += 1n;
  return units;
}
