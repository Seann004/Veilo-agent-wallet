// TEST ONLY. Stands in for the wallet service in automated tests. It performs no proof,
// pool withdrawal or chain transaction; its "finalized" funding evidence is synthetic. The
// merchant payment it signs is a real exact-scheme transaction from a fresh in-memory key,
// validated and settled by the real gateway code against an injected test facilitator.
import { createHash, randomBytes } from "node:crypto";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import type { PaymentRequired } from "@x402/core/types";
import type { FundingProvider, FundingRequest, FundingResult, MerchantSignRequest, MerchantSignResult } from "@veilo/contracts";
import { buildPaymentHeader } from "../../../gateway/test/harness";

type Mode = "finalize" | "not_ready" | "submitted_then_finalize" | "uncertain";

interface Entry {
  req: FundingRequest;
  ref: string;
  payer: KeyPairSigner;
  result: FundingResult;
  signed?: MerchantSignResult;
}

export class TestFundingProvider implements FundingProvider {
  readonly mode = "test" as const;
  behavior: Mode = "finalize";
  readonly calls = { prepare: 0, release: 0, status: 0, sign: 0 };
  readonly #entries = new Map<string, Entry>();

  constructor(private readonly now: () => number) {}

  async prepare(req: FundingRequest): Promise<FundingResult> {
    this.calls.prepare += 1;
    if (this.behavior === "not_ready") return { status: "not_ready", reason: "test provider not ready" };
    const existing = this.#entries.get(req.purchaseId);
    if (existing) return { status: "prepared", fundingRef: existing.ref, payer: existing.payer.address };
    const payer = await generateKeyPairSigner();
    const ref = `testfund_${randomBytes(8).toString("hex")}`;
    this.#entries.set(req.purchaseId, { req, ref, payer, result: { status: "prepared", fundingRef: ref, payer: payer.address } });
    return { status: "prepared", fundingRef: ref, payer: payer.address };
  }

  #finalized(e: Entry): FundingResult {
    const change = e.req.inputNote.value - e.req.payoutUsdc;
    return {
      status: "finalized",
      fundingRef: e.ref,
      evidence: {
        payout: e.req.payoutUsdc,
        tokenFees: 0n,
        change,
        changeCommitment: change > 0n ? createHash("sha256").update(`change:${e.ref}`).digest("hex") : null,
        observedAtMs: this.now(),
        signature: `TESTFUND${randomBytes(24).toString("hex")}`,
        sponsorLamportsSpent: 2_039_280n,
      },
    };
  }

  async release(purchaseId: string): Promise<FundingResult> {
    this.calls.release += 1;
    const e = this.#entries.get(purchaseId);
    if (!e) return { status: "recovery_required", reason: "unknown purchase" };
    if (e.result.status === "prepared") {
      e.result =
        this.behavior === "submitted_then_finalize"
          ? { status: "submitted", fundingRef: e.ref, signature: null }
          : this.behavior === "uncertain"
            ? { status: "uncertain", fundingRef: e.ref, reason: "relayer timeout" }
            : this.#finalized(e);
    }
    return e.result;
  }

  /** Test control: settles a submitted/uncertain withdrawal. */
  settle(purchaseId: string): void {
    const e = this.#entries.get(purchaseId);
    if (e && e.result.status !== "finalized") e.result = this.#finalized(e);
  }

  async status(purchaseId: string): Promise<FundingResult> {
    this.calls.status += 1;
    return this.#entries.get(purchaseId)?.result ?? { status: "not_ready", reason: "unknown purchase" };
  }

  async signMerchantPayment(req: MerchantSignRequest): Promise<MerchantSignResult> {
    const e = this.#entries.get(req.purchaseId);
    if (!e || e.result.status !== "finalized") return { status: "recovery_required", reason: "funding not finalized" };
    if (e.signed) return e.signed;
    if (!req.paymentRequired) return { status: "recovery_required", reason: "no challenge" };
    this.calls.sign += 1;
    const pr = req.paymentRequired as PaymentRequired;
    const accepted = pr.accepts[0];
    if (!accepted || BigInt(accepted.amount) !== req.exactAmountUsdc || accepted.payTo !== req.binding.payTo) {
      return { status: "recovery_required", reason: "challenge does not match the binding" };
    }
    const { header } = await buildPaymentHeader(pr, { payer: e.payer });
    e.signed = { status: "signed", paymentSignatureHeader: header, payer: e.payer.address, messageHash: createHash("sha256").update(header).digest("hex") };
    return e.signed;
  }
}
