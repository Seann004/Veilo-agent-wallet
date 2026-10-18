import {
  externalCallOutcomeWire,
  fundingResultWire,
  merchantSignResultWire,
  payerBindingResultWire,
  swapResultWire,
  type ExternalCallOutcome,
  type ExternalCallSignRequest,
  type FundingBinding,
  type FundingProvider,
  type FundingRequest,
  type FundingResult,
  type MerchantSignRequest,
  type MerchantSignResult,
  type PayerBindingRequest,
  type PayerBindingResult,
  type SwapResult,
} from "@veilo/contracts";
import type { FetchLike } from "./gateway-client";

/** Used when no wallet service is configured. It never funds and never claims success. */
export class UnavailableFundingProvider implements FundingProvider {
  readonly mode = "unavailable" as const;
  constructor(private readonly reason = "private funding (wallet service) is not configured") {}
  async prepare(): Promise<FundingResult> {
    return { status: "not_ready", reason: this.reason };
  }
  async release(): Promise<FundingResult> {
    return { status: "recovery_required", reason: `${this.reason}; released funding cannot be advanced` };
  }
  async status(): Promise<FundingResult> {
    return { status: "not_ready", reason: this.reason };
  }
  async signMerchantPayment(): Promise<MerchantSignResult> {
    return { status: "not_ready", reason: this.reason };
  }
}

const big = (v: bigint) => v.toString();

type CallResult = { ok: true; status: number; body: unknown } | { ok: false; reason: string };

function errorOf(body: unknown): { code: string; message: string } | undefined {
  const e = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  return typeof e?.code === "string" ? { code: e.code, message: typeof e.message === "string" ? e.message : "" } : undefined;
}

/**
 * Live provider: HTTP client for the wallet service funding API. Any transport failure, an
 * unimplemented route or an unparseable reply maps to `not_ready` (before release) or
 * `recovery_required` (after release); it never fabricates progress.
 */
export class WalletFundingProvider implements FundingProvider {
  readonly mode = "live" as const;
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: FetchLike;

  constructor(o: { baseUrl: string; serviceToken: string; fetch?: FetchLike }) {
    this.#base = o.baseUrl.replace(/\/$/, "");
    this.#token = o.serviceToken;
    this.#fetch = o.fetch ?? ((i, init) => fetch(i, init));
  }

  async #call(method: string, path: string, body: unknown): Promise<CallResult> {
    try {
      const res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.#token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(120_000),
        redirect: "error",
      });
      if (res.status === 404 || res.status === 501) return { ok: false, reason: `wallet service funding API not available (HTTP ${res.status})` };
      const text = await res.text();
      return { ok: true, status: res.status, body: text ? (JSON.parse(text) as unknown) : undefined };
    } catch (error) {
      return { ok: false, reason: `wallet service unreachable: ${(error as Error).name}` };
    }
  }

  #funding(r: CallResult, failure: "not_ready" | "recovery_required"): FundingResult {
    if (!r.ok) return { status: failure, reason: r.reason };
    const parsed = fundingResultWire.safeParse(r.body);
    if (!parsed.success) return { status: failure, reason: "wallet service returned an unrecognized funding state" };
    const v = parsed.data;
    if (v.status !== "finalized") return v;
    return {
      status: "finalized",
      fundingRef: v.fundingRef,
      evidence: {
        payout: BigInt(v.evidence.payout),
        tokenFees: BigInt(v.evidence.tokenFees),
        change: BigInt(v.evidence.change),
        changeCommitment: v.evidence.changeCommitment,
        observedAtMs: v.evidence.observedAtMs,
        signature: v.evidence.signature,
        sponsorLamportsSpent: BigInt(v.evidence.sponsorLamportsSpent),
      },
    };
  }

  async prepare(q: FundingRequest): Promise<FundingResult> {
    const body = {
      purchaseId: q.purchaseId,
      operationId: q.operationId,
      payoutUsdc: big(q.payoutUsdc),
      tokenFeeCapUsdc: big(q.tokenFeeCapUsdc),
      sponsorLamportCap: big(q.sponsorLamportCap),
      inputNote: { commitment: q.inputNote.commitment, value: big(q.inputNote.value) },
      binding: q.binding,
    };
    return this.#funding(await this.#call("POST", "/fundings", body), "not_ready");
  }

  async release(purchaseId: string, fundingRef: string): Promise<FundingResult> {
    return this.#funding(await this.#call("POST", `/fundings/${purchaseId}/release`, { fundingRef }), "recovery_required");
  }

  async status(purchaseId: string): Promise<FundingResult> {
    return this.#funding(await this.#call("GET", `/fundings/${purchaseId}`, undefined), "recovery_required");
  }

  async signPayerBinding(q: PayerBindingRequest): Promise<PayerBindingResult> {
    const r = await this.#call("POST", `/fundings/${q.purchaseId}/payer-binding`, { fundingRef: q.fundingRef, operationId: q.operationId, quoteDigest: q.quoteDigest });
    if (!r.ok) return { status: "not_ready", reason: r.reason };
    const parsed = payerBindingResultWire.safeParse(r.body);
    return parsed.success ? parsed.data : { status: "not_ready", reason: "wallet service returned an unrecognized payer-binding state" };
  }

  async signMerchantPayment(q: MerchantSignRequest): Promise<MerchantSignResult> {
    const r = await this.#call("POST", `/fundings/${q.purchaseId}/merchant-payment`, {
      fundingRef: q.fundingRef,
      paymentRequired: q.paymentRequired,
      binding: q.binding,
      exactAmountUsdc: big(q.exactAmountUsdc),
    });
    if (!r.ok) return { status: "recovery_required", reason: r.reason };
    const parsed = merchantSignResultWire.safeParse(r.body);
    if (parsed.success) return parsed.data;
    const error = errorOf(r.body);
    // The wallet answers 503 NOT_READY only from its pre-sign checks (control and pool reads);
    // any other error may follow a signature and stays with reconciliation.
    if (r.status === 503 && error?.code === "NOT_READY") return { status: "not_ready", reason: `wallet not ready to sign: ${error.message}` };
    return {
      status: "recovery_required",
      reason: error ? `wallet service signing error HTTP ${r.status} ${error.code}: ${error.message}` : "wallet service returned an unrecognized signing state",
    };
  }

  async signExternalCall(q: ExternalCallSignRequest): Promise<MerchantSignResult> {
    const r = await this.#call("POST", `/fundings/${q.purchaseId}/external-calls`, {
      fundingRef: q.fundingRef,
      callIndex: q.callIndex,
      paymentRequired: q.paymentRequired,
      binding: q.binding,
    });
    if (!r.ok) return { status: "recovery_required", reason: r.reason };
    const parsed = merchantSignResultWire.safeParse(r.body);
    return parsed.success ? parsed.data : { status: "recovery_required", reason: "wallet service returned an unrecognized signing state" };
  }

  /** The wallet stores a swap before submitting it, so a lost reply is safely asked again. */
  async signSwap(purchaseId: string, fundingRef: string, binding: FundingBinding): Promise<SwapResult> {
    return this.#swap(await this.#call("POST", `/fundings/${purchaseId}/swap`, { fundingRef, binding }));
  }

  async swapOutcome(purchaseId: string): Promise<SwapResult> {
    return this.#swap(await this.#call("GET", `/fundings/${purchaseId}/swap`, undefined));
  }

  #swap(r: CallResult): SwapResult {
    if (!r.ok) return { status: "not_ready", reason: r.reason };
    const parsed = swapResultWire.safeParse(r.body);
    if (!parsed.success) return { status: "not_ready", reason: "wallet service returned an unrecognized swap state" };
    const v = parsed.data;
    if (v.status === "submitted") return { ...v, minOutLamports: BigInt(v.minOutLamports), estOutLamports: BigInt(v.estOutLamports) };
    if (v.status === "finalized") return { ...v, minOutLamports: BigInt(v.minOutLamports), estOutLamports: BigInt(v.estOutLamports), sponsorLamports: BigInt(v.sponsorLamports) };
    return v;
  }

  /** A transport failure is reported as "signed": the call may have settled and must not be re-signed. */
  async externalCallOutcome(purchaseId: string, callIndex: number): Promise<ExternalCallOutcome> {
    const r = await this.#call("GET", `/fundings/${purchaseId}/external-calls/${callIndex}`, undefined);
    if (!r.ok) return { status: "signed" };
    const parsed = externalCallOutcomeWire.safeParse(r.body);
    return parsed.success ? parsed.data : { status: "signed" };
  }
}
