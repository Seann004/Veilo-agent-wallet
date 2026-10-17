import { z } from "zod";
import { baseUnitString } from "./amounts";

/**
 * Funding leg contract between control (policy authority) and the wallet service (notes,
 * proofs, fresh payment wallets). Control rechecks authority and advances the purchase's
 * authorization/funding/merchant state immediately before each call that releases material:
 *
 *   prepare  — after control records `prepare_proof`; wallet builds the proof and reserves a
 *              fresh payment wallet for this purchase. Nothing may leave the wallet yet.
 *   release  — after control records `release_proof`; wallet releases the proof to the relayer
 *              for withdrawal submission (the withdrawal-submission recheck happens here too).
 *   status   — read-only reconciliation; never releases new material.
 *   signMerchantPayment — after control records `sign_merchant`; the fresh wallet signs exactly
 *              one x402 exact payment for the given challenge. A repeated call for the same
 *              purchase returns the same signed payment and never signs a second transfer.
 *
 * Every call is idempotent by purchaseId. Before acting, the wallet may verify the matching
 * stage through `GET /purchases/:id` on control with its service credential.
 *
 * A provider that cannot act returns `not_ready` (nothing released, safe to retry) or
 * `recovery_required` (owner attention). It never returns a success-shaped state it did not
 * observe on chain.
 */
/**
 * Terms of an owner-approved external x402 resource paid as a bounded batch: one funded payer
 * makes at most `maxCalls` payments of exactly `unitUsdc` each to the binding's recipient.
 * Those payments share one payer, so they are linkable to each other on chain.
 */
export interface ExternalBatchTerms {
  /** Exact path, or a `/*` prefix (see @veilo/x402-client resourcePathMatches). */
  resourcePath: string;
  unitUsdc: string;
  maxCalls: number;
}

export interface FundingBinding {
  origin: string;
  gatewayIdentity: string;
  sku: string;
  network: string;
  mint: string;
  payTo: string;
  merchantAta: string;
  allowedFeePayers: string[];
  /** Present only for an external x402 batch; Veilo services never set it. */
  external?: ExternalBatchTerms | undefined;
}

export interface FundingRequest {
  purchaseId: string;
  operationId: string;
  /** Exact merchant charge the fresh wallet must hold (test-USDC base units). */
  payoutUsdc: bigint;
  /** Upper bound for token fees on the withdrawal. */
  tokenFeeCapUsdc: bigint;
  /** Upper bound for sponsor lamports (ATA rent plus transaction fees). */
  sponsorLamportCap: bigint;
  /** The pool note control reserved for this purchase; the wallet must spend exactly this note. */
  inputNote: { commitment: string; value: bigint };
  binding: FundingBinding;
}

export interface WithdrawalEvidence {
  payout: bigint;
  tokenFees: bigint;
  change: bigint;
  changeCommitment: string | null;
  /** Service-observed finalized time (epoch ms). */
  observedAtMs: number;
  signature: string;
  sponsorLamportsSpent: bigint;
}

export type FundingResult =
  | { status: "not_ready"; reason: string }
  | { status: "recovery_required"; reason: string }
  | { status: "prepared"; fundingRef: string; payer: string }
  | { status: "submitted"; fundingRef: string; signature: string | null }
  | { status: "uncertain"; fundingRef: string; reason: string }
  | { status: "finalized"; fundingRef: string; evidence: WithdrawalEvidence }
  | { status: "expired_unsettled"; fundingRef: string; reason: string };

export interface MerchantSignRequest {
  purchaseId: string;
  fundingRef: string;
  /** Decoded PAYMENT-REQUIRED object from the gateway challenge for the current quote. */
  paymentRequired: unknown;
  binding: FundingBinding;
  exactAmountUsdc: bigint;
}

/** One payment of an external batch, signed by the batch's funded payer. */
export interface ExternalCallSignRequest {
  purchaseId: string;
  fundingRef: string;
  /** Zero-based and contiguous; each earlier call must have a resolved chain outcome. */
  callIndex: number;
  paymentRequired: unknown;
  binding: FundingBinding;
}

/** Chain outcome of one signed external call, by the payer's history and the signed message. */
export type ExternalCallOutcome =
  | { status: "none" }
  | { status: "signed" }
  | { status: "finalized"; signature: string }
  | { status: "expired_unsettled" }
  | { status: "failed"; signature: string | null };

export type MerchantSignResult =
  | { status: "not_ready"; reason: string }
  | { status: "recovery_required"; reason: string }
  | { status: "signed"; paymentSignatureHeader: string; payer: string; messageHash: string };

/**
 * Proof that the one-time payer of an unreleased funding attempt controls its key. The wallet
 * signs exactly payerBindingMessage(operationId, quoteDigest, payer) with that payer key, and only
 * before the attempt's proof is released.
 */
export interface PayerBindingRequest {
  purchaseId: string;
  fundingRef: string;
  /** Marketplace operation ID the payer is being bound to. */
  operationId: string;
  quoteDigest: string;
}

export type PayerBindingResult =
  | { status: "not_ready"; reason: string }
  | { status: "refused"; reason: string }
  | { status: "signed"; payer: string; proof: string };

export interface FundingProvider {
  /** "live" talks to the wallet service; "unavailable" never funds; "test" exists only in automated tests. */
  readonly mode: "live" | "unavailable" | "test";
  prepare(request: FundingRequest): Promise<FundingResult>;
  release(purchaseId: string, fundingRef: string): Promise<FundingResult>;
  status(purchaseId: string): Promise<FundingResult>;
  signMerchantPayment(request: MerchantSignRequest): Promise<MerchantSignResult>;
  /** Present only where the provider supports external x402 batches. */
  signExternalCall?(request: ExternalCallSignRequest): Promise<MerchantSignResult>;
  externalCallOutcome?(purchaseId: string, callIndex: number): Promise<ExternalCallOutcome>;
  /** Present only where the provider can prove payer-key possession (marketplace hires). */
  signPayerBinding?(request: PayerBindingRequest): Promise<PayerBindingResult>;
}

/** Wire form of the wallet-service funding API (bigints as decimal strings). */
export const fundingBindingWire = z
  .object({
    origin: z.string(),
    gatewayIdentity: z.string(),
    sku: z.string(),
    network: z.string(),
    mint: z.string(),
    payTo: z.string(),
    merchantAta: z.string(),
    allowedFeePayers: z.array(z.string()),
    external: z
      .object({
        resourcePath: z.string().regex(/^\/[A-Za-z0-9._~/-]{0,200}(\/\*)?$/),
        unitUsdc: baseUnitString,
        maxCalls: z.number().int().min(1).max(100),
      })
      .strict()
      .optional(),
  })
  .strict();

export const externalCallRequestWire = z
  .object({
    fundingRef: z.string().min(1),
    callIndex: z.number().int().min(0).max(99),
    paymentRequired: z.unknown(),
    binding: fundingBindingWire,
  })
  .strict();

export const externalCallOutcomeWire = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({ status: z.literal("signed") }),
  z.object({ status: z.literal("finalized"), signature: z.string().min(32) }),
  z.object({ status: z.literal("expired_unsettled") }),
  z.object({ status: z.literal("failed"), signature: z.string().min(32).nullable() }),
]);

export const fundingRequestWire = z
  .object({
    purchaseId: z.uuid(),
    operationId: z.string(),
    payoutUsdc: baseUnitString,
    tokenFeeCapUsdc: baseUnitString,
    sponsorLamportCap: baseUnitString,
    inputNote: z.object({ commitment: z.string().regex(/^[0-9a-f]{64}$/), value: baseUnitString }).strict(),
    binding: fundingBindingWire,
  })
  .strict();

export const fundingResultWire = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_ready"), reason: z.string() }),
  z.object({ status: z.literal("recovery_required"), reason: z.string() }),
  z.object({ status: z.literal("prepared"), fundingRef: z.string().min(1), payer: z.string().min(32) }),
  z.object({ status: z.literal("submitted"), fundingRef: z.string().min(1), signature: z.string().nullable() }),
  z.object({ status: z.literal("uncertain"), fundingRef: z.string().min(1), reason: z.string() }),
  z.object({
    status: z.literal("finalized"),
    fundingRef: z.string().min(1),
    evidence: z
      .object({
        payout: baseUnitString,
        tokenFees: baseUnitString,
        change: baseUnitString,
        changeCommitment: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
        observedAtMs: z.number().int().positive(),
        signature: z.string().min(32),
        sponsorLamportsSpent: baseUnitString,
      })
      .strict(),
  }),
  z.object({ status: z.literal("expired_unsettled"), fundingRef: z.string().min(1), reason: z.string() }),
]);

export const merchantSignResultWire = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_ready"), reason: z.string() }),
  z.object({ status: z.literal("recovery_required"), reason: z.string() }),
  z.object({
    status: z.literal("signed"),
    paymentSignatureHeader: z.string().min(1),
    payer: z.string().min(32),
    messageHash: z.string().min(1),
  }),
]);

export const payerBindingRequestWire = z
  .object({
    fundingRef: z.string().min(1),
    operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    quoteDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const payerBindingResultWire = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_ready"), reason: z.string() }),
  z.object({ status: z.literal("refused"), reason: z.string() }),
  z.object({ status: z.literal("signed"), payer: z.string().min(32).max(44), proof: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/) }),
]);

/** Wallet-service routes the live provider calls (control service credential as bearer). */
export const WALLET_FUNDING_ROUTES = {
  prepare: "POST /fundings",
  release: "POST /fundings/:purchaseId/release",
  status: "GET /fundings/:purchaseId",
  signMerchantPayment: "POST /fundings/:purchaseId/merchant-payment",
  signPayerBinding: "POST /fundings/:purchaseId/payer-binding",
  signExternalCall: "POST /fundings/:purchaseId/external-calls",
  externalCallOutcome: "GET /fundings/:purchaseId/external-calls/:callIndex",
} as const;
