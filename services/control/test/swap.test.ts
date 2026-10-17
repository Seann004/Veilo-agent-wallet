import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENTS, DEVNET_SOL_USDC_WHIRLPOOL, WRAPPED_SOL_MINT } from "@veilo/contracts";
import type { FundingBinding, FundingProvider, FundingRequest, FundingResult, MerchantSignResult, SwapResult } from "@veilo/contracts";
import { computeRequestDigest } from "@veilo/contracts/gateway";
import { PurchaseOrchestrator } from "../src/integration/orchestrator";
import { authorizePurchase } from "../src/ledger/authorize";
import { pauseAgent } from "../src/ledger/authority";
import { getPurchaseRow } from "../src/ledger/purchases";
import { approveSwapService, SWAP_SKU, SwapRunner } from "../src/swap/service";
import { activateDefaults, addNotes, createEnv, intentTask, type TestEnv } from "./helpers";

/** Funding stand-in: a synthetic finalized withdrawal and a scripted swap outcome. */
class SwapTestFunding implements FundingProvider {
  readonly mode = "test" as const;
  readonly reqs = new Map<string, FundingRequest>();
  readonly swapBindings = new Map<string, FundingBinding>();
  outcome: SwapResult["status"] = "finalized";
  async prepare(req: FundingRequest): Promise<FundingResult> {
    this.reqs.set(req.purchaseId, req);
    return { status: "prepared", fundingRef: req.purchaseId, payer: "FreshPayer1111111111111111111111111111111111" };
  }
  async release(purchaseId: string): Promise<FundingResult> {
    return this.status(purchaseId);
  }
  async status(purchaseId: string): Promise<FundingResult> {
    const req = this.reqs.get(purchaseId);
    if (!req) return { status: "not_ready", reason: "unknown purchase" };
    const change = req.inputNote.value - req.payoutUsdc;
    return {
      status: "finalized",
      fundingRef: purchaseId,
      evidence: {
        payout: req.payoutUsdc,
        tokenFees: 0n,
        change,
        changeCommitment: change > 0n ? createHash("sha256").update(`change:${purchaseId}`).digest("hex") : null,
        observedAtMs: 1,
        signature: `FUND${createHash("sha256").update(purchaseId).digest("hex")}`,
        sponsorLamportsSpent: 5_083_840n,
      },
    };
  }
  async signMerchantPayment(): Promise<MerchantSignResult> {
    return { status: "recovery_required", reason: "swaps are not merchant payments" };
  }
  async signSwap(purchaseId: string, _fundingRef: string, binding: FundingBinding): Promise<SwapResult> {
    this.swapBindings.set(purchaseId, binding);
    return this.swapOutcome();
  }
  async swapOutcome(): Promise<SwapResult> {
    const sig = "SWAPSIG".padEnd(88, "x");
    const amounts = { minOutLamports: 70_000_000n, estOutLamports: 70_700_000n, destination: "Owner1111111111111111111111111111111111111" };
    if (this.outcome === "finalized") return { status: "finalized", signature: sig, sponsorLamports: 2_049_280n, ...amounts };
    if (this.outcome === "submitted") return { status: "submitted", signature: sig, ...amounts };
    if (this.outcome === "failed") return { status: "failed", signature: sig, reason: "the swap failed on-chain" };
    return { status: "not_ready", reason: "relayer unavailable" };
  }
}

let env: TestEnv;
let funding: SwapTestFunding;
let orchestrator: PurchaseOrchestrator;
let serviceId: string;

beforeEach(() => {
  env = createEnv();
  const prince = DEFAULT_AGENTS.find((a) => a.name === "Prince")!;
  activateDefaults(env, { agents: { Prince: { allowedSkus: [...prince.policy.allowedSkus, SWAP_SKU] } } });
  addNotes(env, [1_000_000n, 1_000_000n]);
  funding = new SwapTestFunding();
  orchestrator = new PurchaseOrchestrator({ ledger: env.ledger, gateway: undefined, permits: undefined, funding, swap: new SwapRunner(env.ledger, funding) });
  serviceId = approveSwapService(env.ledger, env.ws.id, 500_000n, "owner").serviceId;
});
afterEach(() => env.cleanup());

function swapPurchase(key: string): string {
  const input = {};
  const { purchase } = authorizePurchase(env.ledger, {
    workspaceId: env.ws.id,
    agentId: env.agents.Prince.id,
    idempotencyKey: key,
    serviceId,
    sku: SWAP_SKU,
    paymentPath: "private_x402",
    requestDigest: computeRequestDigest(SWAP_SKU, input),
    taskId: intentTask(env, env.agents.Prince.id, key),
  });
  orchestrator.storeInput(purchase, input);
  return purchase.id;
}

describe("devnet swap purchase", () => {
  it("funds privately, swaps on the pinned pool and settles the amount and sponsor cost once", async () => {
    const id = swapPurchase("swap-1");
    await orchestrator.drive(id);
    const p = getPurchaseRow(env.ledger, id);
    expect(p).toMatchObject({ funding_state: "finalized", merchant_state: "finalized", fulfilment_state: "delivered", recovery_state: "none" });
    expect(funding.reqs.get(id)!.payoutUsdc).toBe(500_000n);
    expect(funding.swapBindings.get(id)!.swap).toMatchObject({ whirlpool: DEVNET_SOL_USDC_WHIRLPOOL, outputMint: WRAPPED_SOL_MINT, inputMint: env.ws.mint });
    const view = orchestrator.view(id) as { result?: { kind: string; minOutLamports: string; signature: string } };
    expect(view.result).toMatchObject({ kind: "swap", minOutLamports: "70000000" });
    const sponsor = env.db.prepare(`SELECT amount FROM financial_event WHERE purchase_id = ? AND kind = 'expense_settled' AND asset = 'lamports'`).pluck().get(id);
    expect(BigInt(sponsor as bigint)).toBe(5_083_840n + 2_049_280n);
  });

  it("a swap still landing stays signed, and a failed swap leaves the USDC recoverable", async () => {
    funding.outcome = "submitted";
    const pending = swapPurchase("swap-2");
    await orchestrator.drive(pending);
    expect(getPurchaseRow(env.ledger, pending)).toMatchObject({ merchant_state: "signed", fulfilment_state: "not_started" });

    funding.outcome = "failed";
    const failed = swapPurchase("swap-3");
    await orchestrator.drive(failed);
    expect(getPurchaseRow(env.ledger, failed)).toMatchObject({ merchant_state: "expired_unsettled", fulfilment_state: "abandoned", recovery_state: "recoverable" });
  });

  it("signs no swap after the agent is paused, and refuses agents without the swap SKU", async () => {
    const id = swapPurchase("swap-4");
    pauseAgent(env.ledger, env.ws.id, env.agents.Prince.id, "owner");
    await orchestrator.drive(id).catch(() => undefined);
    expect(funding.swapBindings.has(id)).toBe(false);
    expect(() =>
      authorizePurchase(env.ledger, {
        workspaceId: env.ws.id,
        agentId: env.agents.Mira.id,
        idempotencyKey: "mira-swap",
        serviceId,
        sku: SWAP_SKU,
        paymentPath: "private_x402",
        requestDigest: computeRequestDigest(SWAP_SKU, {}),
        taskId: intentTask(env, env.agents.Mira.id, "mira-swap"),
      }),
    ).toThrow();
  });
});
