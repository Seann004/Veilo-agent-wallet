/**
 * Seeded gateway catalog. Amounts are integers: x402 charges in test-USDC base units
 * (6 decimals), prepaid charges and pack issuance in gateway microcredits. These tariffs
 * demonstrate wallet behavior; they are not commercial pricing or provider rates.
 */

export const GATEWAY_SKUS = [
  "inference-credit-pack",
  "research-basic",
  "research-expanded",
  "summarize",
  "analyze",
  "content-package",
  "specialist-job",
] as const;
export type GatewaySku = (typeof GATEWAY_SKUS)[number];

export const INFERENCE_SKUS = ["summarize", "analyze", "content-package"] as const;
export type InferenceSku = (typeof INFERENCE_SKUS)[number];

export type SkuKind = "credit_pack" | "dataset" | "inference" | "specialist";

export interface SkuDefinition {
  sku: GatewaySku;
  title: string;
  kind: SkuKind;
  /** Fixed per-call x402 charge in test-USDC base units, or null when x402 is not offered. */
  x402Amount: bigint | null;
  /** Fixed prepaid charge in gateway microcredits, or null when prepaid usage is not offered. */
  prepaidUnits: bigint | null;
  /** Microcredits issued once per finalized pack purchase. */
  issuesUnits: bigint | null;
  /** Enforced upper bound on prompt tokens (conservative, see token-bound rules). */
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  dataset: "basic" | "expanded" | null;
  delivery: string;
}

export const CREDIT_PACK_UNITS = 1_000_000n;

export const GATEWAY_CATALOG: Readonly<Record<GatewaySku, SkuDefinition>> = {
  "inference-credit-pack": {
    sku: "inference-credit-pack",
    title: "Inference credit pack",
    kind: "credit_pack",
    x402Amount: 1_000_000n,
    prepaidUnits: null,
    issuesUnits: CREDIT_PACK_UNITS,
    maxInputTokens: null,
    maxOutputTokens: null,
    dataset: null,
    delivery: "Issues 1,000,000 gateway microcredits once, after finalized settlement",
  },
  "research-basic": {
    sku: "research-basic",
    title: "Research dataset (basic)",
    kind: "dataset",
    x402Amount: 100_000n,
    prepaidUnits: null,
    issuesUnits: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    dataset: "basic",
    delivery: "Small licensed demo fixture dataset with source metadata",
  },
  "research-expanded": {
    sku: "research-expanded",
    title: "Research dataset (expanded)",
    kind: "dataset",
    x402Amount: 200_000n,
    prepaidUnits: null,
    issuesUnits: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    dataset: "expanded",
    delivery: "Expanded licensed demo fixture dataset with source metadata",
  },
  summarize: {
    sku: "summarize",
    title: "Summarize",
    kind: "inference",
    x402Amount: 100_000n,
    prepaidUnits: 100_000n,
    issuesUnits: null,
    maxInputTokens: 8_000,
    maxOutputTokens: 1_000,
    dataset: null,
    delivery: "One bounded model summary",
  },
  analyze: {
    sku: "analyze",
    title: "Analyze",
    kind: "inference",
    x402Amount: 200_000n,
    prepaidUnits: 200_000n,
    issuesUnits: null,
    maxInputTokens: 8_000,
    maxOutputTokens: 2_000,
    dataset: null,
    delivery: "One bounded model analysis",
  },
  "content-package": {
    sku: "content-package",
    title: "Content package",
    kind: "inference",
    x402Amount: 300_000n,
    prepaidUnits: 300_000n,
    issuesUnits: null,
    maxInputTokens: 8_000,
    maxOutputTokens: 3_000,
    dataset: null,
    delivery: "Three channel drafts and a seven-day calendar, schema validated",
  },
  // Sold only by a seller host: price and recipient come from one published listing version,
  // so the operator gateway refuses it (no fixed x402 or prepaid price).
  "specialist-job": {
    sku: "specialist-job",
    title: "Marketplace specialist job",
    kind: "specialist",
    x402Amount: null,
    prepaidUnits: null,
    issuesUnits: null,
    maxInputTokens: 8_000,
    maxOutputTokens: 3_000,
    dataset: null,
    delivery: "One fixed-scope specialist deliverable for the quoted marketplace job",
  },
};

export function isGatewaySku(value: unknown): value is GatewaySku {
  return typeof value === "string" && (GATEWAY_SKUS as readonly string[]).includes(value);
}

export function isInferenceSku(value: unknown): value is InferenceSku {
  return typeof value === "string" && (INFERENCE_SKUS as readonly string[]).includes(value);
}

export const GATEWAY_CREDIT_LABEL = "Demo inference credits — backed by the operator's OpenRouter account";
export const GATEWAY_CREDIT_UNIT = "gateway_microcredits";
export const TEST_USDC_UNIT = "usdc_base_units";
export const FIXTURE_DATA_LABEL = "demo fixture data";
export const SPONSORED_PLANNING_LABEL = "operator-sponsored planning";
export const MAX_PLANNING_CALLS_PER_TASK = 2;
