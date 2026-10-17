import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSigner } from "@solana/kit";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENTS, DEMO_TOKEN_MINT, DEVNET_CAIP2 } from "@veilo/contracts";
import type {
  ExternalCallOutcome,
  ExternalCallSignRequest,
  FundingProvider,
  FundingRequest,
  FundingResult,
  MerchantSignResult,
} from "@veilo/contracts";
import { computeRequestDigest } from "@veilo/contracts/gateway";
import { deriveAta } from "@veilo/x402-client";
import { ExternalBatchRunner } from "../src/external/batch";
import { approveExternalBinding, disableExternalBinding, EXTERNAL_BATCH_SKU, type ExternalBindingRow } from "../src/external/bindings";
import { PurchaseOrchestrator } from "../src/integration/orchestrator";
import { authorizePurchase } from "../src/ledger/authorize";
import { getPurchaseRow } from "../src/ledger/purchases";
import { activatePolicyVersion, insertAgentPolicyDraft } from "../src/ledger/workspace";
import { immediate } from "@veilo/db";
import { SellerOriginPolicy } from "../src/marketplace/origin-policy";
import { activateDefaults, addNotes, createEnv, type TestEnv } from "./helpers";

const UNIT = 1000n;
const MAX_CALLS = 3;
const PATH = "/solana-mainnet";

type SellerMode = "ok" | "raise_price" | "change_pay_to" | "drop_reply" | "no_challenge" | "error_after_pay";

/** Per-request x402 seller: a top-up and a per-call price for one recipient, like a paid RPC. */
class FakeSeller {
  mode: SellerMode = "ok";
  /** Payment headers the seller settled on chain. */
  readonly paid: string[] = [];
  /** Every payment header received, settled or not. */
  readonly received: string[] = [];
  unpaidRequests = 0;
  server!: Server;
  origin = "";
  constructor(
    readonly payTo: string,
    readonly feePayer: string,
  ) {}

  challenge(): PaymentRequired {
    const amount = this.mode === "raise_price" ? "2000" : "1000";
    const payTo = this.mode === "change_pay_to" ? this.feePayer : this.payTo;
    const opt = (a: string) => ({ scheme: "exact", network: DEVNET_CAIP2, amount: a, payTo, maxTimeoutSeconds: 60, asset: DEMO_TOKEN_MINT, extra: { feePayer: this.feePayer } });
    return { x402Version: 2, resource: { url: `${this.origin}${PATH}`, description: "rpc", mimeType: "application/json" }, accepts: [opt("1000000"), opt(amount)] } as PaymentRequired;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const header = req.headers["payment-signature"];
        if (typeof header !== "string") {
          this.unpaidRequests += 1;
          if (this.mode === "no_challenge") {
            res.writeHead(200, { "content-type": "application/json" }).end("{}");
            return;
          }
          const pr = this.challenge();
          res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) }).end(JSON.stringify(pr));
          return;
        }
        this.received.push(header);
        if (this.mode === "error_after_pay") {
          res.writeHead(500).end("upstream failed");
          return;
        }
        this.paid.push(header);
        if (this.mode === "drop_reply") {
          req.socket.destroy();
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
        const settle = encodePaymentResponseHeader({ success: true, transaction: `SIG${header}`, network: DEVNET_CAIP2, payer: "payer" } as never);
        res
          .writeHead(200, { "content-type": "application/json", "PAYMENT-RESPONSE": settle })
          .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { method: body.method, slot: 123 } }));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
}

/** Funding stand-in: synthetic finalized withdrawal; a call "lands" once the seller received its header. */
class ExternalTestFunding implements FundingProvider {
  readonly mode = "test" as const;
  readonly signed = new Map<string, string>();
  /** Per call: what the chain shows when the seller never got the payment. */
  unsettled: "signed" | "expired_unsettled" = "expired_unsettled";
  constructor(readonly seller: FakeSeller) {}
  async prepare(req: FundingRequest): Promise<FundingResult> {
    this.reqs.set(req.purchaseId, req);
    return { status: "prepared", fundingRef: req.purchaseId, payer: "FreshPayer1111111111111111111111111111111111" };
  }
  readonly reqs = new Map<string, FundingRequest>();
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
        sponsorLamportsSpent: 2_039_280n,
      },
    };
  }
  async signMerchantPayment(): Promise<MerchantSignResult> {
    return { status: "recovery_required", reason: "external batches are signed per call" };
  }
  async signExternalCall(req: ExternalCallSignRequest): Promise<MerchantSignResult> {
    const key = `${req.purchaseId}:${req.callIndex}`;
    let header = this.signed.get(key);
    if (header === undefined) {
      if (!req.binding.external) return { status: "recovery_required", reason: "not a batch" };
      header = `hdr${req.callIndex}${randomBytes(4).toString("hex")}`;
      this.signed.set(key, header);
    }
    return { status: "signed", paymentSignatureHeader: header, payer: "FreshPayer1111111111111111111111111111111111", messageHash: createHash("sha256").update(header).digest("hex") };
  }
  async externalCallOutcome(purchaseId: string, callIndex: number): Promise<ExternalCallOutcome> {
    const header = this.signed.get(`${purchaseId}:${callIndex}`);
    if (header === undefined) return { status: "none" };
    if (this.seller.paid.includes(header)) return { status: "finalized", signature: `SIG${header}`.padEnd(64, "x") };
    return { status: this.unsettled };
  }
}

let env: TestEnv;
let seller: FakeSeller;
let funding: ExternalTestFunding;
let orchestrator: PurchaseOrchestrator;
let runner: ExternalBatchRunner;
let binding: ExternalBindingRow;

beforeEach(async () => {
  env = createEnv();
  const prince = DEFAULT_AGENTS.find((a) => a.name === "Prince")!;
  activateDefaults(env, { agents: { Prince: { allowedSkus: [...prince.policy.allowedSkus, EXTERNAL_BATCH_SKU] } } });
  addNotes(env, [1_000_000n, 1_000_000n, 1_000_000n, 1_000_000n, 1_000_000n]);
  const [merchant, feePayer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  seller = new FakeSeller(merchant.address, feePayer.address);
  await seller.start();
  funding = new ExternalTestFunding(seller);
  const origins = new SellerOriginPolicy({ localTestOrigins: [seller.origin] });
  runner = new ExternalBatchRunner({ ledger: env.ledger, funding, origins, timeoutMs: 2_000 });
  orchestrator = new PurchaseOrchestrator({ ledger: env.ledger, gateway: undefined, permits: undefined, funding, external: runner });
  binding = await approveExternalBinding(
    env.ledger,
    env.ws.id,
    "owner",
    {
      label: "Paid RPC",
      origin: seller.origin,
      resourcePath: PATH,
      network: DEVNET_CAIP2,
      mint: DEMO_TOKEN_MINT,
      payTo: merchant.address,
      payToAta: await deriveAta(merchant.address, DEMO_TOKEN_MINT),
      unitPriceUsdc: UNIT,
      maxCalls: MAX_CALLS,
      allowedFeePayers: [feePayer.address],
      allowedRpcMethods: ["getSlot", "getTokenSupply"],
    },
    origins,
    100_000n,
  );
});

afterEach(async () => {
  await new Promise((r) => seller.server.close(r));
  env.cleanup();
});

const rpc = (method: string) => ({ method: "POST" as const, path: PATH, body: { jsonrpc: "2.0", id: 1, method } });

function buy(key: string, calls = [rpc("getSlot"), rpc("getTokenSupply")]) {
  const input = { bindingId: binding.id, calls };
  const { purchase } = authorizePurchase(env.ledger, {
    workspaceId: env.ws.id,
    agentId: env.agents.Prince.id,
    idempotencyKey: key,
    serviceId: binding.service_id,
    sku: EXTERNAL_BATCH_SKU,
    paymentPath: "private_x402",
    requestDigest: computeRequestDigest(EXTERNAL_BATCH_SKU, input),
  });
  orchestrator.storeInput(purchase, input);
  return purchase.id;
}

const row = (id: string) => getPurchaseRow(env.ledger, id);

describe("external x402 batch through private funding", () => {
  it("reserves unit × max calls, pays each call once, settles what was spent and makes the rest recoverable", async () => {
    const id = buy("b1");
    expect(row(id).price_usdc).toBe(UNIT * BigInt(MAX_CALLS));
    const r = await orchestrator.drive(id);
    expect(r.execution.blocked, JSON.stringify(r.execution.blocked)).toBeNull();
    expect(r.purchase).toMatchObject({ funding_state: "finalized", merchant_state: "finalized", fulfilment_state: "delivered", recovery_state: "recoverable" });
    expect(seller.paid).toHaveLength(2);
    const result = runner.result(id) as { calls: Array<{ payment: string; execution: string; settlementSignature: string }>; linkability: string };
    expect(result.calls.map((c) => [c.payment, c.execution])).toEqual([["paid", "response_stored"], ["paid", "response_stored"]]);
    expect(result.linkability).toMatch(/linkable/);
    expect(runner.response(id, 1)).toMatchObject({ json: { result: { method: "getTokenSupply" } } });
    const expense = env.db.prepare(`SELECT sum(amount) FROM financial_event WHERE purchase_id = ? AND kind = 'expense_settled' AND asset = 'usdc'`).pluck().get(id);
    expect(BigInt(expense as bigint)).toBe(2n * UNIT);
    const attempts = env.db.prepare(`SELECT attempt_no, observed_commitment FROM chain_attempt WHERE purchase_id = ? AND leg = 'merchant' ORDER BY attempt_no`).all(id);
    expect(attempts).toEqual([{ attempt_no: 1n, observed_commitment: "finalized" }, { attempt_no: 2n, observed_commitment: "finalized" }]);
    // Driving again changes nothing and pays nothing.
    await orchestrator.drive(id);
    expect(seller.paid).toHaveLength(2);
  });

  it("refuses a raised price, a changed recipient or a missing challenge without signing, and stops the batch", async () => {
    for (const mode of ["raise_price", "change_pay_to", "no_challenge"] as const) {
      seller.mode = mode;
      const id = buy(`stop-${mode}`);
      const r = await orchestrator.drive(id);
      expect(r.purchase).toMatchObject({ merchant_state: "expired_unsettled", fulfilment_state: "abandoned", recovery_state: "recoverable" });
      expect(funding.signed.size).toBe(0);
      const calls = runner.calls(id);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.state).toBe("refused");
    }
    expect(seller.paid).toHaveLength(0);
  });

  it("a lost reply is reconciled from chain evidence and never paid twice", async () => {
    seller.mode = "drop_reply";
    const id = buy("lost", [rpc("getSlot")]);
    const r = await orchestrator.drive(id);
    expect(seller.paid).toHaveLength(1);
    expect(r.purchase).toMatchObject({ merchant_state: "finalized", fulfilment_state: "paid_without_result" });
    expect(runner.calls(id)[0]!.state).toBe("paid_no_result");
    seller.mode = "ok";
    await orchestrator.drive(id);
    expect(seller.paid).toHaveLength(1);
  });

  it("an unresolved payment holds the batch; later calls are not bought until chain evidence arrives", async () => {
    seller.mode = "error_after_pay";
    funding.unsettled = "signed";
    // The seller errored before settling: no chain record of call 0 yet.
    const id = buy("held");
    const r = await orchestrator.drive(id);
    expect(r.execution.blocked?.code).toBe("SETTLEMENT_UNCERTAIN");
    expect(runner.calls(id).map((c) => c.state)).toEqual(["sent"]);
    await orchestrator.drive(id);
    expect(seller.received).toHaveLength(1);
    // Proven unsettled: call 0 is unpaid and the batch stops; call 1 is never bought.
    funding.unsettled = "expired_unsettled";
    const done = await orchestrator.drive(id);
    expect(runner.calls(id).map((c) => c.state)).toEqual(["unpaid"]);
    expect(done.purchase).toMatchObject({ merchant_state: "expired_unsettled", recovery_state: "recoverable" });
    expect(funding.signed.size).toBe(1);
  });

  it("refuses input outside the binding before it is stored", async () => {
    const tooMany = { bindingId: binding.id, calls: [rpc("getSlot"), rpc("getSlot"), rpc("getSlot"), rpc("getSlot")] };
    const badMethod = { bindingId: binding.id, calls: [rpc("sendTransaction")] };
    const badPath = { bindingId: binding.id, calls: [{ method: "POST" as const, path: "/base-mainnet", body: { method: "getSlot" } }] };
    for (const [i, input] of [tooMany, badMethod, badPath].entries()) {
      const { purchase } = authorizePurchase(env.ledger, {
        workspaceId: env.ws.id,
        agentId: env.agents.Prince.id,
        idempotencyKey: `bad-${i}`,
        serviceId: binding.service_id,
        sku: EXTERNAL_BATCH_SKU,
        paymentPath: "private_x402",
        requestDigest: computeRequestDigest(EXTERNAL_BATCH_SKU, input),
      });
      expect(() => orchestrator.storeInput(purchase, input)).toThrow(/refused/);
    }
  });

  it("a disabled binding cannot be funded or bought, and approval rejects mainnet, other mints and a wrong ATA", async () => {
    const id = buy("disabled");
    disableExternalBinding(env.ledger, env.ws.id, "owner", binding.id);
    const r = await orchestrator.drive(id);
    expect(r.purchase.funding_state).toBe("abandoned");
    expect(seller.unpaidRequests).toBe(0);
    expect(() =>
      authorizePurchase(env.ledger, {
        workspaceId: env.ws.id,
        agentId: env.agents.Prince.id,
        idempotencyKey: "after-disable",
        serviceId: binding.service_id,
        sku: EXTERNAL_BATCH_SKU,
        paymentPath: "private_x402",
        requestDigest: "0".repeat(64),
      }),
    ).toThrow(/not approved/);

    const base = {
      label: "x",
      origin: seller.origin,
      resourcePath: PATH,
      network: DEVNET_CAIP2,
      mint: DEMO_TOKEN_MINT,
      payTo: binding.pay_to,
      payToAta: binding.pay_to_ata,
      unitPriceUsdc: UNIT,
      maxCalls: 2,
      allowedFeePayers: [seller.feePayer],
    };
    const origins = new SellerOriginPolicy({ localTestOrigins: [seller.origin] });
    await expect(approveExternalBinding(env.ledger, env.ws.id, "owner", { ...base, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, origins, 100_000n)).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    await expect(approveExternalBinding(env.ledger, env.ws.id, "owner", { ...base, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, origins, 100_000n)).rejects.toMatchObject({ code: "WRONG_MINT" });
    await expect(approveExternalBinding(env.ledger, env.ws.id, "owner", { ...base, payToAta: seller.feePayer }, origins, 100_000n)).rejects.toMatchObject({ code: "SERVICE_NOT_ALLOWED" });
    await expect(approveExternalBinding(env.ledger, env.ws.id, "owner", { ...base, origin: "http://10.0.0.5" }, origins, 100_000n)).rejects.toMatchObject({ code: "SERVICE_NOT_ALLOWED" });
    await expect(approveExternalBinding(env.ledger, env.ws.id, "owner", { ...base, maxCalls: 100, unitPriceUsdc: 10_000n }, origins, 100_000n)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("batch reservations count against agent caps like any other purchase", async () => {
    const prince = DEFAULT_AGENTS.find((a) => a.name === "Prince")!;
    const agentId = env.agents.Prince.id;
    const draft = immediate(env.ledger.db, () =>
      insertAgentPolicyDraft(env.ledger, env.ws.id, agentId, { ...prince.policy, allowedSkus: [...prince.policy.allowedSkus, EXTERNAL_BATCH_SKU], maxPurchaseTestUsdc: "2000" }, "owner"),
    );
    activatePolicyVersion(env.ledger, env.ws.id, agentId, Number(draft.version), { type: "owner", id: "owner" });
    expect(() => buy("over-cap")).toThrow(/per-purchase limit/);
  });
});
