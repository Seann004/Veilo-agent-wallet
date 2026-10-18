import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENTS, DEVNET_SOL_USDC_WHIRLPOOL, WRAPPED_SOL_MINT } from "@veilo/contracts";
import type { FundingBinding, FundingProvider, FundingRequest, FundingResult, MerchantSignResult, SwapResult } from "@veilo/contracts";
import { computeRequestDigest } from "@veilo/contracts/gateway";
import { PurchaseOrchestrator } from "../src/integration/orchestrator";
import { authorizePurchase } from "../src/ledger/authorize";
import { pauseAgent } from "../src/ledger/authority";
import { getPurchaseRow, markRecoverable } from "../src/ledger/purchases";
import { walletRecordSwapNotSigned } from "../src/ledger/wallet-bridge";
import { approveSwapService, disableSwapService, SWAP_SKU, SwapRunner } from "../src/swap/service";
import { makeStack, type Stack } from "./fixtures/stack";
import { activateDefaults, addNotes, addService, createEnv, intentTask, type TestEnv } from "./helpers";

/** Funding stand-in: a synthetic finalized withdrawal and a scripted swap outcome. */
class SwapTestFunding implements FundingProvider {
  readonly mode = "test" as const;
  readonly reqs = new Map<string, FundingRequest>();
  readonly swapBindings = new Map<string, FundingBinding>();
  outcome: SwapResult["status"] = "finalized";
  fundingPending = false;
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
    if (this.fundingPending) return { status: "submitted", fundingRef: purchaseId, signature: null };
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
    if (this.outcome === "recovery_required") return { status: "recovery_required", reason: "no owner address is configured to receive the swap output" };
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

function authorizeSwap(key: string, swapInput: unknown, o: { taskId?: string; digestOf?: unknown } = {}) {
  return authorizePurchase(env.ledger, {
    workspaceId: env.ws.id,
    agentId: env.agents.Prince.id,
    idempotencyKey: key,
    serviceId,
    sku: SWAP_SKU,
    paymentPath: "private_x402",
    requestDigest: computeRequestDigest(SWAP_SKU, "digestOf" in o ? o.digestOf : swapInput),
    taskId: o.taskId ?? intentTask(env, env.agents.Prince.id, key),
    swapInput,
  }).purchase;
}

function swapPurchase(key: string, amount = 500_000n): string {
  const input = { amountUsdc: amount.toString() };
  const purchase = authorizeSwap(key, input);
  orchestrator.storeInput(purchase, input);
  return purchase.id;
}

const purchaseCount = () => env.db.prepare(`SELECT COUNT(*) FROM purchase`).pluck().get();

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

  it("moves a swap the wallet never signed out of signed so its funded wallet becomes recoverable", async () => {
    funding.outcome = "not_ready";
    const id = swapPurchase("swap-6");
    await orchestrator.drive(id).catch(() => undefined);
    expect(getPurchaseRow(env.ledger, id)).toMatchObject({ funding_state: "finalized", merchant_state: "signed" });
    expect(() => markRecoverable(env.ledger, id, "owner recovery")).toThrow(/may still settle/);
    walletRecordSwapNotSigned(env.ledger, id);
    expect(walletRecordSwapNotSigned(env.ledger, id)).toMatchObject({ merchant_state: "expired_unsettled", fulfilment_state: "abandoned" });
    expect(markRecoverable(env.ledger, id, "owner recovery")).toMatchObject({ recovery_state: "recoverable" });

    const unfunded = swapPurchase("swap-7");
    expect(() => walletRecordSwapNotSigned(env.ledger, unfunded)).toThrow(/swap leg is not_started/);
  });

  it("blocks a swap the wallet refused as RECOVERY_REQUIRED without forging a settlement state", async () => {
    funding.outcome = "recovery_required";
    const id = swapPurchase("swap-5");
    await orchestrator.drive(id);
    expect(getPurchaseRow(env.ledger, id)).toMatchObject({ funding_state: "finalized", merchant_state: "signed", recovery_state: "none" });
    expect(orchestrator.view(id).blocked).toMatchObject({ code: "RECOVERY_REQUIRED" });
  });

  it("refuses new swaps once the owner turns approval off, and re-approval restores them", () => {
    expect(disableSwapService(env.ledger, env.ws.id, "owner")).toEqual({ serviceId });
    expect(() => swapPurchase("swap-off")).toThrow(/service binding is not approved/);
    approveSwapService(env.ledger, env.ws.id, 500_000n, "owner");
    expect(() => swapPurchase("swap-on")).not.toThrow();
  });

  it("lets swaps whose funding left the pool settle after approval is withdrawn", async () => {
    funding.fundingPending = true;
    const inFlight = swapPurchase("swap-off-1");
    await orchestrator.drive(inFlight).catch(() => undefined);
    expect(getPurchaseRow(env.ledger, inFlight)).toMatchObject({ authorization_state: "released", funding_state: "submitted" });
    funding.fundingPending = false;
    funding.outcome = "not_ready";
    const signed = swapPurchase("swap-off-2");
    await orchestrator.drive(signed).catch(() => undefined);
    expect(getPurchaseRow(env.ledger, signed)).toMatchObject({ funding_state: "finalized", merchant_state: "signed" });

    disableSwapService(env.ledger, env.ws.id, "owner");
    funding.outcome = "finalized";
    await orchestrator.drive(inFlight);
    expect(getPurchaseRow(env.ledger, inFlight)).toMatchObject({ funding_state: "finalized", merchant_state: "finalized", fulfilment_state: "delivered" });
    funding.outcome = "failed";
    await orchestrator.drive(signed);
    expect(getPurchaseRow(env.ledger, signed)).toMatchObject({ merchant_state: "expired_unsettled", recovery_state: "recoverable" });
  });

  it("releases a reserved swap when approval is withdrawn, and re-approval does not resume it", async () => {
    const id = swapPurchase("swap-off-3");
    expect(env.db.prepare(`SELECT COUNT(*) FROM note WHERE reserved_purchase_id = ?`).pluck().get(id)).toBe(1n);
    disableSwapService(env.ledger, env.ws.id, "owner");
    await orchestrator.drive(id);
    expect(getPurchaseRow(env.ledger, id)).toMatchObject({ authorization_state: "rejected", funding_state: "abandoned", merchant_state: "abandoned" });
    expect(env.db.prepare(`SELECT status FROM reservation WHERE purchase_id = ?`).pluck().get(id)).toBe("released");
    expect(env.db.prepare(`SELECT COUNT(*) FROM note WHERE reserved_purchase_id = ?`).pluck().get(id)).toBe(0n);

    approveSwapService(env.ledger, env.ws.id, 500_000n, "owner");
    await orchestrator.drive(id).catch(() => undefined);
    expect(getPurchaseRow(env.ledger, id).authorization_state).toBe("rejected");
    expect(funding.reqs.has(id)).toBe(false);
    expect(funding.swapBindings.has(id)).toBe(false);
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
        requestDigest: computeRequestDigest(SWAP_SKU, { amountUsdc: "1000" }),
        taskId: intentTask(env, env.agents.Mira.id, "mira-swap"),
        swapInput: { amountUsdc: "1000" },
      }),
    ).toThrow(/does not permit this SKU/);
  });
});

describe("agent-chosen swap amount", () => {
  it("prices, reserves, funds and settles exactly the requested amount below the approved maximum", async () => {
    const id = swapPurchase("small", 10_000n);
    const p = getPurchaseRow(env.ledger, id);
    expect(p.price_usdc).toBe(10_000n);
    expect(env.db.prepare(`SELECT reserved_usdc FROM reservation WHERE purchase_id = ?`).pluck().get(id)).toBe(10_000n);
    await orchestrator.drive(id);
    expect(funding.reqs.get(id)!.payoutUsdc).toBe(10_000n);
    expect(getPurchaseRow(env.ledger, id)).toMatchObject({ merchant_state: "finalized", fulfilment_state: "delivered" });
    const settled = env.db.prepare(`SELECT amount FROM financial_event WHERE purchase_id = ? AND kind = 'expense_settled' AND asset = 'usdc'`).pluck().all(id);
    expect(settled.map((v) => BigInt(v as bigint))).toEqual([10_000n]);
  });

  it("accepts the approved maximum itself and refuses one base unit more", () => {
    expect(getPurchaseRow(env.ledger, swapPurchase("at-max", 500_000n)).price_usdc).toBe(500_000n);
    const before = purchaseCount();
    expect(() => authorizeSwap("over-max", { amountUsdc: "500001" })).toThrow(/exceeds the owner-approved maximum per swap/);
    expect(purchaseCount()).toBe(before);
  });

  it("refuses zero and anything that is not a canonical base-unit integer string", () => {
    for (const amountUsdc of ["0", "0.01", "-5", "01", "1e3", " 100", "", 100, 1.5, null]) {
      expect(() => authorizeSwap(`bad-${String(amountUsdc)}`, { amountUsdc })).toThrow(/base unit/);
    }
    expect(purchaseCount()).toBe(0n);
  });

  it("never lets the agent supply the pool, direction, slippage or destination", () => {
    const extras = [
      {},
      undefined,
      { amountUsdc: "1000", whirlpool: "Other1111111111111111111111111111111111111" },
      { amountUsdc: "1000", outputMint: env.ws.mint, inputMint: WRAPPED_SOL_MINT },
      { amountUsdc: "1000", destination: "Attacker11111111111111111111111111111111111" },
      { amountUsdc: "1000", slippageBps: 10_000 },
      ["1000"],
    ];
    for (const [i, input] of extras.entries()) {
      expect(() => authorizeSwap(`extra-${i}`, input)).toThrow(/carries only amountUsdc/);
    }
    expect(purchaseCount()).toBe(0n);
    // A purchase authorized for the amount alone still cannot be given other terms later.
    const purchase = authorizeSwap("store-extra", { amountUsdc: "1000" });
    expect(() => orchestrator.storeInput(purchase, { amountUsdc: "1000", destination: "Attacker11111111111111111111111111111111111" })).toThrow(/carries only amountUsdc/);
    expect(orchestrator.input(purchase.id)).toBeUndefined();
  });

  it("binds the amount to the request digest at authorization and when the input is stored", () => {
    expect(() => authorizeSwap("mismatch", { amountUsdc: "400000" }, { digestOf: { amountUsdc: "1000" } })).toThrow(/does not match the purchase request digest/);
    expect(purchaseCount()).toBe(0n);
    const purchase = authorizeSwap("bound", { amountUsdc: "1000" });
    expect(() => orchestrator.storeInput(purchase, { amountUsdc: "400000" })).toThrow(/swap amount differs from the authorized price/);
    // Replaying the key with another amount is a different request, not a re-price.
    expect(() => authorizeSwap("bound", { amountUsdc: "2000" })).toThrow(/different request/);
    expect(getPurchaseRow(env.ledger, purchase.id).price_usdc).toBe(1_000n);
  });

  it("refuses a swap amount on any service other than the approved swap", () => {
    const research = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 1_000n }]);
    expect(() =>
      authorizePurchase(env.ledger, {
        workspaceId: env.ws.id,
        agentId: env.agents.Prince.id,
        idempotencyKey: "research-with-amount",
        serviceId: research,
        sku: "research-basic",
        paymentPath: "private_x402",
        requestDigest: computeRequestDigest("research-basic", { question: "q" }),
        taskId: intentTask(env, env.agents.Prince.id, "research-with-amount"),
        swapInput: { amountUsdc: "1000" },
      }),
    ).toThrow(/only the owner-approved swap takes a swap amount/);
  });

  it("applies the per-purchase, task and agent lifetime caps to the requested amount", () => {
    approveSwapService(env.ledger, env.ws.id, 2_000_000n, "owner");
    addNotes(env, [1_000_000n, 1_000_000n, 1_000_000n, 1_000_000n, 1_000_000n, 1_000_000n]);
    // Prince: 0.50 USDC per purchase, 1.00 per task, 2.00 lifetime and rolling.
    expect(() => authorizeSwap("per-purchase", { amountUsdc: "500001" })).toThrow(/per-purchase limit/);
    const task = intentTask(env, env.agents.Prince.id, "one-task");
    authorizeSwap("t-1", { amountUsdc: "400000" }, { taskId: task });
    authorizeSwap("t-2", { amountUsdc: "400000" }, { taskId: task });
    expect(() => authorizeSwap("t-3", { amountUsdc: "400000" }, { taskId: task })).toThrow(/task budget would be exceeded/);
    expect(authorizeSwap("t-4", { amountUsdc: "200000" }, { taskId: task }).price_usdc).toBe(200_000n);
    authorizeSwap("l-1", { amountUsdc: "500000" });
    authorizeSwap("l-2", { amountUsdc: "400000" });
    expect(() => authorizeSwap("l-3", { amountUsdc: "200000" })).toThrow(/agent lifetime allocation would be exceeded/);
    expect(authorizeSwap("l-4", { amountUsdc: "100000" }).price_usdc).toBe(100_000n);
  });

  it("checks the amount against the maximum in force at authorization", () => {
    approveSwapService(env.ledger, env.ws.id, 1_000n, "owner");
    expect(() => authorizeSwap("lowered", { amountUsdc: "1001" })).toThrow(/exceeds the owner-approved maximum/);
    expect(authorizeSwap("within", { amountUsdc: "1000" }).price_usdc).toBe(1_000n);
  });
});

describe("swap purchase requests over HTTP", () => {
  let st: Stack | undefined;
  afterEach(async () => {
    await st?.close();
    st = undefined;
  });

  it("prices the purchase from the requested amount and refuses any other swap term", async () => {
    const prince = DEFAULT_AGENTS.find((a) => a.name === "Prince")!;
    st = await makeStack({ agents: { Prince: { allowedSkus: [...prince.policy.allowedSkus, SWAP_SKU] } } });
    const swapService = approveSwapService(st.env.ledger, st.env.ws.id, 500_000n, "owner").serviceId;
    const request = (key: string, input: Record<string, unknown> | undefined) =>
      st!.call("/purchase-intents", {
        method: "POST",
        headers: { authorization: `Bearer ${st!.worker("Prince")}` },
        body: {
          idempotencyKey: key,
          serviceId: swapService,
          sku: SWAP_SKU,
          paymentPath: "private_x402",
          requestDigest: computeRequestDigest(SWAP_SKU, input ?? {}),
          taskId: intentTask(st!.env, st!.env.agents.Prince.id, key),
          ...(input !== undefined ? { input } : {}),
        },
      });
    const ok = await request("http-small", { amountUsdc: "10000" });
    expect(ok.status).toBeLessThan(300);
    expect((ok.body as { purchase: { price: { amount: string } } }).purchase.price.amount).toBe("10000");
    for (const [key, input] of [
      ["http-none", undefined],
      ["http-empty", {}],
      ["http-pool", { amountUsdc: "10000", whirlpool: "Other1111111111111111111111111111111111111" }],
      ["http-over", { amountUsdc: "500001" }],
      ["http-decimal", { amountUsdc: "0.01" }],
    ] as const) {
      const r = await request(key, input);
      expect(r.status, key).toBeGreaterThanOrEqual(400);
    }
    expect(st.count(`SELECT count(*) FROM purchase WHERE sku = '${SWAP_SKU}'`)).toBe(1);
  });
});
