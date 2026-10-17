import { isAddress } from "@solana/kit";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../gateway/digest";
import { MARKETPLACE_FEE_BPS, MARKETPLACE_LIMITS } from "./limits";

const solanaAddress = z.string().refine((v): boolean => isAddress(v), "must be a base58 Solana address");
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256 digest");
const baseUnits = z.string().regex(/^(0|[1-9][0-9]{0,19})$/, "must be a canonical nonnegative integer");
const isoTimestamp = z.iso.datetime({ offset: true });

export const RUNTIME_KINDS = ["managed_template", "remote_endpoint"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

/** Reviewed managed templates. Sellers configure them; they never upload executable code. */
export const MANAGED_TEMPLATES = ["research-summary", "structured-analysis", "content-package"] as const;
export type ManagedTemplate = (typeof MANAGED_TEMPLATES)[number];

export const LISTING_STATUSES = ["draft", "in_review", "published", "rejected", "suspended", "archived"] as const;

export const JOB_STATES = [
  "created",
  "awaiting_approval",
  "awaiting_payment",
  "queued",
  "running",
  "input_required",
  "cancel_requested",
  "succeeded",
  "cancelled",
  "failed",
  "delivery_uncertain",
  "expired",
] as const;
export type JobState = (typeof JOB_STATES)[number];

/**
 * Allowed job transitions. `awaiting_payment → queued` additionally requires a reconciled
 * finalized receipt (or a free quote); the state machine alone never proves payment.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  created: ["awaiting_approval", "cancelled", "expired"],
  awaiting_approval: ["awaiting_payment", "cancelled", "expired"],
  awaiting_payment: ["queued", "cancelled", "expired", "failed"],
  queued: ["running", "cancel_requested", "failed"],
  running: ["succeeded", "input_required", "failed", "delivery_uncertain", "cancel_requested", "queued"],
  input_required: ["running", "queued", "cancel_requested", "expired", "failed"],
  cancel_requested: ["cancelled", "succeeded", "failed", "delivery_uncertain"],
  delivery_uncertain: ["succeeded", "failed"],
  succeeded: [],
  cancelled: [],
  failed: [],
  expired: [],
};

export const FINANCIAL_STATES = [
  "free",
  "quoted",
  "approval_pending",
  "reserved",
  "funding_pending",
  "funded",
  "settlement_pending",
  "settled",
  "rejected",
  "expired_unpaid",
  "funding_uncertain",
  "settlement_uncertain",
  "failed_unpaid",
  "refund_requested",
  "partially_refunded",
  "refunded",
] as const;
export type FinancialState = (typeof FINANCIAL_STATES)[number];

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** F = floor(B × r / 10000). This release refuses any r other than MARKETPLACE_FEE_BPS. */
export function quoteAmounts(base: bigint, feeBps: number = MARKETPLACE_FEE_BPS): { base: bigint; fee: bigint; total: bigint } {
  if (base < 0n) throw new RangeError("base must be nonnegative");
  if (feeBps !== MARKETPLACE_FEE_BPS) throw new RangeError(`fee basis points must be ${MARKETPLACE_FEE_BPS} in this release`);
  const fee = (base * BigInt(feeBps)) / 10_000n;
  return { base, fee, total: base + fee };
}

/**
 * A seller endpoint is a bare public https origin. Loopback or private test sellers are admitted
 * only through an explicit operator allowlist outside this schema, and every connection must
 * still re-check the resolved address because DNS can change after review.
 */
export function remoteOriginProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username || url.password) return "must not contain credentials";
  if (url.origin !== value.replace(/\/$/, "")) return "must be a bare origin without path, query or fragment";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return "must be a public host";
  if (/^[0-9.]+$/.test(host) || host.startsWith("[")) return "must be a DNS name, not an IP literal";
  if (!host.includes(".")) return "must be a fully qualified host";
  return null;
}

export const remoteOriginSchema = z.string().max(300).superRefine((v, ctx) => {
  const problem = remoteOriginProblem(v);
  if (problem) ctx.addIssue({ code: "custom", message: `remote origin ${problem}` });
});

export const listingVersionInputSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    summary: z.string().trim().min(10).max(500),
    description: z.string().trim().min(10).max(8_000),
    runtimeKind: z.enum(RUNTIME_KINDS),
    template: z.enum(MANAGED_TEMPLATES).nullable(),
    remoteOrigin: remoteOriginSchema.nullable(),
    sellerInstructions: z.string().trim().max(8_000).default(""),
    inputSchema: z.object({ briefHint: z.string().max(500), maxBriefChars: z.number().int().min(100).max(MARKETPLACE_LIMITS.maxBriefChars) }).strict(),
    outputSchema: z.object({ format: z.enum(["markdown", "json"]), sections: z.array(z.string().min(1).max(80)).max(20) }).strict(),
    priceBaseUnits: baseUnits,
    payoutVersionId: z.uuid(),
    turnaroundMinutes: z.number().int().min(1).max(10_080),
    refundTerms: z.string().trim().min(10).max(2_000),
    dataHandling: z.string().trim().min(10).max(2_000),
    termsVersion: z.string().trim().min(1).max(40),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.runtimeKind === "managed_template" && (v.template === null || v.remoteOrigin !== null)) {
      ctx.addIssue({ code: "custom", message: "managed listings name a template and no remote origin" });
    }
    if (v.runtimeKind === "remote_endpoint" && (v.remoteOrigin === null || v.template !== null)) {
      ctx.addIssue({ code: "custom", message: "remote listings name an origin and no template" });
    }
  });
export type ListingVersionInput = z.infer<typeof listingVersionInputSchema>;

/** Every field bound by the quote digest. Application IDs stay off chain. */
export const quoteFieldsSchema = z
  .object({
    id: z.uuid(),
    operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    buyerWorkspaceId: z.uuid(),
    jobId: z.uuid(),
    listingVersionId: z.uuid(),
    runtimeVersion: z.string().min(1).max(80),
    inputDigest: hex64,
    network: z.string().min(1).max(80),
    genesisHash: z.string().min(32).max(64),
    mint: solanaAddress,
    decimals: z.number().int().min(0).max(18),
    recipient: solanaAddress,
    recipientAta: solanaAddress,
    sellerOrigin: z.string().min(1).max(300),
    sellerIdentity: z.string().min(1).max(120),
    baseUnits,
    feeBps: z.number().int().min(0).max(10_000),
    feeUnits: baseUnits,
    totalUnits: baseUnits,
    maxNetworkFeeLamports: baseUnits,
    termsVersion: z.string().min(1).max(40),
    expiresAt: isoTimestamp,
  })
  .strict();
export type QuoteFields = z.infer<typeof quoteFieldsSchema>;

export const quoteSchema = quoteFieldsSchema.extend({ quoteDigest: hex64 }).strict();
export type MarketplaceQuote = z.infer<typeof quoteSchema>;

/** Domain-separated digest over the canonical quote fields. A digest alone authenticates nothing. */
export function computeQuoteDigest(fields: QuoteFields): string {
  return sha256Hex(`veilo:marketplace-quote:v1\n${canonicalJson(quoteFieldsSchema.parse(fields))}`);
}

/** Recomputes the digest and the fee arithmetic; returns a problem description or null. */
export function verifyQuote(quote: MarketplaceQuote): string | null {
  const { quoteDigest, ...fields } = quote;
  if (computeQuoteDigest(fields) !== quoteDigest) return "quote digest does not match its fields";
  let amounts: { fee: bigint; total: bigint };
  try {
    amounts = quoteAmounts(BigInt(quote.baseUnits), quote.feeBps);
  } catch (error) {
    return (error as Error).message;
  }
  if (amounts.fee !== BigInt(quote.feeUnits) || amounts.total !== BigInt(quote.totalUnits)) return "quote fee arithmetic is inconsistent";
  return null;
}

export function computeInputDigest(brief: string): string {
  return sha256Hex(`veilo:marketplace-brief:v1\n${brief}`);
}

/** Input of the `specialist-job` seller SKU. The job and quote digest bind one payment to one job. */
export const specialistJobInputSchema = z
  .object({
    jobId: z.uuid(),
    listingVersionId: z.uuid(),
    quoteDigest: hex64,
    brief: z.string().min(1).max(MARKETPLACE_LIMITS.maxBriefChars),
  })
  .strict();
export type SpecialistJobInput = z.infer<typeof specialistJobInputSchema>;

export const resultArtifactSchema = z
  .object({
    artifactId: z.uuid(),
    sha256: hex64,
    mimeType: z.enum(["text/markdown", "application/json", "text/plain"]),
    bytes: z.number().int().min(0).max(MARKETPLACE_LIMITS.maxUploadBytes),
  })
  .strict();

export const resultEnvelopeSchema = z
  .object({
    jobId: z.uuid(),
    attemptId: z.uuid(),
    leaseGeneration: z.number().int().min(1),
    schemaVersion: z.literal("veilo.result.v1"),
    status: z.enum(["complete", "incomplete"]),
    summary: z.string().min(1).max(2_000),
    artifacts: z.array(resultArtifactSchema).max(MARKETPLACE_LIMITS.maxAttachments),
    sourceReferences: z.array(z.string().max(500)).max(50).default([]),
  })
  .strict();
export type ResultEnvelope = z.infer<typeof resultEnvelopeSchema>;

/**
 * Canonical bytes a local controller signs when it calls the marketplace. Binding method,
 * path, body digest, timestamp and nonce stops replay to another route or a later time.
 */
export function controllerSigningMessage(p: { method: string; path: string; bodyDigest: string; timestamp: string; nonce: string; keyId: string }): string {
  return `veilo:controller-request:v1\n${p.keyId}\n${p.method.toUpperCase()}\n${p.path}\n${p.bodyDigest}\n${p.timestamp}\n${p.nonce}`;
}

export const CONTROLLER_REQUEST_MAX_SKEW_MS = 60_000;
