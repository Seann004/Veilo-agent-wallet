import { DEVNET_CAIP2 } from "@veilo/contracts";
import { verifyPaymentRequired } from "@veilo/x402-client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import { verifyCounters } from "../src/ledger/credits";
import { buildPaymentHeader, makeHarness, MINT, VALID_CONTENT, type Harness } from "./harness";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const count = (h: Harness, table: string) => Number((h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: bigint }).n);

async function quoteAndChallenge(h: Harness, token: string, sku = "inference-credit-pack", input: unknown = { packs: 1 }) {
  const q = await h.quote(token, sku, input);
  expect(q.status).toBe(201);
  const quote = { quoteId: q.body.quoteId as string, operationId: q.operationId, requestDigest: q.requestDigest };
  const c = await h.challenge(token, quote);
  expect(c.status).toBe(402);
  return { quote, pr: c.paymentRequired!, quoteBody: q.body };
}

describe("quotes and x402 challenge", () => {
  it("issues an immutable quote and a PAYMENT-REQUIRED challenge the client binding accepts", async () => {
    h = await makeHarness();
    const { token } = h.account();
    const { pr, quoteBody } = await quoteAndChallenge(h, token);
    expect(quoteBody).toMatchObject({ sku: "inference-credit-pack", charge: { amount: "1000000", unit: "usdc_base_units" }, paymentPath: "x402" });
    const verified = await verifyPaymentRequired(pr, {
      origin: "http://127.0.0.1:4104",
      resourceUrl: quoteBody.executeUrl,
      gatewayIdentity: "veilo-gateway-devnet",
      sku: "inference-credit-pack",
      network: DEVNET_CAIP2,
      mint: MINT,
      payTo: h.merchant.address,
      merchantAta: quoteBody.recipient.merchantAta,
      maxAmount: 1_000_000n,
      exactAmount: 1_000_000n,
      allowedFeePayers: [h.facilitator.feePayer.address],
    });
    expect(verified.amount).toBe(1_000_000n);
    expect(pr.accepts[0]?.extra.memo).toBeUndefined();
  });

  it("QUO-01/X402-04: same operation and digest returns the same quote; a changed request is 409 with no charge", async () => {
    h = await makeHarness();
    const { token } = h.account();
    const a = await h.quote(token, "research-basic", { query: "repair cafes" }, "op-fixed");
    const b = await h.quote(token, "research-basic", { query: "repair cafes" }, "op-fixed");
    expect(b.status).toBe(200);
    expect(b.body.quoteId).toBe(a.body.quoteId);
    const changed = await h.quote(token, "research-basic", { query: "something else" }, "op-fixed");
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const quote = { quoteId: a.body.quoteId, operationId: "op-fixed", requestDigest: changed.requestDigest };
    const exec = await h.call("POST", `/v1/purchases/${quote.quoteId}/execute`, token, { operationId: quote.operationId, requestDigest: quote.requestDigest });
    expect(exec.status).toBe(409);
    expect(count(h, "quotes")).toBe(1);
    expect(count(h, "payment_attempts")).toBe(0);
    expect(h.facilitator.settleCalls).toBe(0);
  });

  it("fails closed when the facilitator does not advertise devnet exact", async () => {
    h = await makeHarness();
    h.facilitator.supportedKinds = [{ x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: h.facilitator.feePayer.address } }];
    await h.gateway.refreshAcceptance();
    const { token } = h.account();
    const q = await h.quote(token, "research-basic", { query: "x" });
    expect(q.status).toBe(503);
    expect(h.gateway.health().x402.accepting).toBe(false);
  });

  it("requires authentication and hides other accounts' quotes", async () => {
    h = await makeHarness();
    const a = h.account();
    const b = h.account();
    const { quote } = await quoteAndChallenge(h, a.token, "research-basic", { query: "q" });
    expect((await h.call("GET", `/v1/purchases/${quote.quoteId}/result`, undefined)).status).toBe(401);
    expect((await h.call("GET", `/v1/purchases/${quote.quoteId}/result`, b.token)).status).toBe(404);
  });

  it("rejects overlong inference input at quote time", async () => {
    h = await makeHarness();
    const { token } = h.account();
    const q = await h.quote(token, "summarize", { text: "x".repeat(9_000) });
    expect(q.status).toBe(413);
    expect(q.body.error.code).toBe("INPUT_TOO_LONG");
  });
});

describe("paid execution", () => {
  it("IDEM-01: credit pack pays once, issues once, and retries return the stored result", async () => {
    h = await makeHarness();
    const { token, accountId } = h.account();
    const { quote, pr } = await quoteAndChallenge(h, token);
    const { header } = await buildPaymentHeader(pr);
    const first = await h.pay(token, quote, header);
    expect(first.status).toBe(200);
    expect(first.body.state).toBe("delivered");
    expect(first.body.result).toMatchObject({ kind: "credit_pack", issuedUnits: "1000000" });
    expect(decodePaymentResponseHeader(first.headers.get("payment-response") as string).success).toBe(true);
    const again = await h.pay(token, quote, header);
    const noHeader = await h.call("POST", `/v1/purchases/${quote.quoteId}/execute`, token, { operationId: quote.operationId, requestDigest: quote.requestDigest });
    const result = await h.call("GET", `/v1/purchases/${quote.quoteId}/result`, token);
    for (const r of [again, noHeader, result]) {
      expect(r.status).toBe(200);
      expect(r.body.result).toEqual(first.body.result);
    }
    expect(h.facilitator.settleCalls).toBe(1);
    expect(count(h, "credit_issuances")).toBe(1);
    const bal = await h.call("GET", "/credits/balance", token);
    expect(bal.body).toMatchObject({ issued: "1000000", usable: "1000000", label: "Demo inference credits — backed by the operator's OpenRouter account" });
    verifyCounters(h.db, accountId);
  });

  it("X402-02 (gateway): a wrong amount or recipient is rejected before any claim or settlement", async () => {
    h = await makeHarness();
    const { token } = h.account();
    const { quote, pr } = await quoteAndChallenge(h, token, "research-basic", { query: "q" });
    const wrongAmount = await h.pay(token, quote, (await buildPaymentHeader(pr, { amount: 99_999n })).header);
    expect(wrongAmount.status).toBe(400);
    expect(wrongAmount.body.error.message).toContain("amount_mismatch");
    const wrongAta = await h.pay(token, quote, (await buildPaymentHeader(pr, { destinationOwner: h.facilitator.feePayer.address })).header);
    expect(wrongAta.status).toBe(400);
    expect(count(h, "payment_attempts")).toBe(0);
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0);
  });

  it("X402-03: one payment cannot be reused for another quote or account", async () => {
    h = await makeHarness();
    const a = h.account();
    const b = h.account();
    const qa = await quoteAndChallenge(h, a.token);
    const qb = await quoteAndChallenge(h, b.token);
    const { header } = await buildPaymentHeader(qa.pr);
    expect((await h.pay(a.token, qa.quote, header)).status).toBe(200);
    const reuse = await h.pay(b.token, qb.quote, header);
    expect(reuse.status).toBe(400); // accepted block bound to quote A's resource
    const sameAccountOtherQuote = await quoteAndChallenge(h, a.token);
    const reuse2 = await h.pay(a.token, sameAccountOtherQuote.quote, header);
    expect([400, 409]).toContain(reuse2.status);
    expect(count(h, "credit_issuances")).toBe(1);
    expect(h.facilitator.settleCalls).toBe(1);
  });

  it("REC-02: a lost settle response reconciles the existing transaction without a new debit", async () => {
    h = await makeHarness();
    const { token } = h.account();
    const { quote, pr } = await quoteAndChallenge(h, token);
    h.facilitator.settleMode = "lost_response";
    const r = await h.pay(token, quote, (await buildPaymentHeader(pr)).header);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("delivered");
    expect(h.facilitator.settleCalls).toBe(1);
    expect(count(h, "credit_issuances")).toBe(1);
  });

  it("pending settlement returns existing state, never a new challenge", async () => {
    h = await makeHarness();
    const { token } = h.account();
    const { quote, pr } = await quoteAndChallenge(h, token);
    h.facilitator.settleMode = "not_landed";
    const r = await h.pay(token, quote, (await buildPaymentHeader(pr)).header);
    expect(r.status).toBe(202);
    expect(r.body.state).toBe("pending_settlement");
    const retry = await h.call("POST", `/v1/purchases/${quote.quoteId}/execute`, token, { operationId: quote.operationId, requestDigest: quote.requestDigest });
    expect(retry.status).toBe(202);
    expect(retry.headers.get("payment-required")).toBeNull();
    expect(h.facilitator.settleCalls).toBe(1);
  });

  it("QUO-01: a payload accepted before expiry that settles after expiry is honored once at the original price", async () => {
    h = await makeHarness();
    const { token } = h.account();
    const { quote, pr } = await quoteAndChallenge(h, token);
    h.facilitator.settleMode = "not_landed";
    const { header, payer } = await buildPaymentHeader(pr);
    expect((await h.pay(token, quote, header)).status).toBe(202);
    h.clock.advance(11 * 60_000); // past the 10-minute quote TTL
    const attempt = h.db.prepare("SELECT message_hash FROM payment_attempts").get() as { message_hash: string };
    h.chain.land("late-sig", attempt.message_hash, payer.address);
    const r = await h.call("GET", `/v1/purchases/${quote.quoteId}/result`, token);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "delivered", charge: { amount: "1000000" }, payment: { txSignature: "late-sig" } });
    const again = await h.call("POST", `/v1/purchases/${quote.quoteId}/execute`, token, { operationId: quote.operationId, requestDigest: quote.requestDigest });
    expect(again.status).toBe(200);
    expect(count(h, "credit_issuances")).toBe(1);
  });

  it("rejects a new payload after quote expiry", async () => {
    h = await makeHarness();
    const { token } = h.account();
    const { quote, pr } = await quoteAndChallenge(h, token);
    h.clock.advance(11 * 60_000);
    const r = await h.pay(token, quote, (await buildPaymentHeader(pr)).header);
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe("QUOTE_EXPIRED");
    expect(h.facilitator.settleCalls).toBe(0);
  });

  it("QUO-02 (gateway): no re-quote while a payment may settle; re-quote only after proven non-settlement", async () => {
    h = await makeHarness();
    const { token } = h.account();
    const q = await h.quote(token, "inference-credit-pack", { packs: 1 }, "op-requote");
    const quote = { quoteId: q.body.quoteId, operationId: "op-requote", requestDigest: q.requestDigest };
    const c = await h.challenge(token, quote);
    h.facilitator.settleMode = "not_landed";
    await h.pay(token, quote, (await buildPaymentHeader(c.paymentRequired!)).header);
    h.clock.advance(11 * 60_000);
    const same = await h.quote(token, "inference-credit-pack", { packs: 1 }, "op-requote");
    expect(same.body.quoteId).toBe(quote.quoteId);
    h.chain.height = 2_000n; // blockhash expired, transaction never landed
    await h.call("GET", `/v1/purchases/${quote.quoteId}/result`, token);
    const fresh = await h.quote(token, "inference-credit-pack", { packs: 1 }, "op-requote");
    expect(fresh.status).toBe(201);
    expect(fresh.body.quoteId).not.toBe(quote.quoteId);
    expect((h.db.prepare("SELECT state FROM payment_attempts").get() as { state: string }).state).toBe("failed");
    expect(count(h, "credit_issuances")).toBe(0);
  });

  it("CRE-01: restart after finalized settlement but before issuance issues the pack exactly once", async () => {
    let crash = true;
    h = await makeHarness({ hooks: { afterPaymentFinalized: () => { if (crash) throw new Error("simulated crash"); } } });
    const { token, accountId } = h.account();
    const { quote, pr } = await quoteAndChallenge(h, token);
    expect((await h.pay(token, quote, (await buildPaymentHeader(pr)).header)).status).toBe(500);
    expect(count(h, "payment_events")).toBe(1);
    expect(count(h, "credit_issuances")).toBe(0);
    crash = false;
    const shared = { chain: h.chain, facilitator: h.facilitator, merchant: h.merchant, clock: h.clock, permitPem: h.permitPem };
    const dbPath = h.dbPath;
    await h.close();
    h = await makeHarness({ dbPath, shared });
    await h.gateway.recover();
    await h.gateway.recover();
    expect(count(h, "credit_issuances")).toBe(1);
    const bal = await h.call("GET", "/credits/balance", token);
    expect(bal.body.issued).toBe("1000000");
    expect(h.facilitator.settleCalls).toBe(1);
    verifyCounters(h.db, accountId);
  });

  it("delivers a labeled fixture research dataset", async () => {
    h = await makeHarness();
    const { token } = h.account();
    const { quote, pr } = await quoteAndChallenge(h, token, "research-expanded", { query: "repair cafes" });
    const r = await h.pay(token, quote, (await buildPaymentHeader(pr)).header);
    expect(r.body.result).toMatchObject({ kind: "dataset", label: "demo fixture data", dataset: "expanded" });
    expect(r.body.result.records).toHaveLength(12);
    expect(r.body.result.records[0].source).toMatchObject({ license: "CC0-1.0", label: "demo fixture data" });
  });

  it("per-call inference never debits prepaid credits; invalid content schema is saved incomplete without retry", async () => {
    h = await makeHarness();
    const { token } = h.account();
    const s = await quoteAndChallenge(h, token, "summarize", { text: "Repair cafes help." });
    const r = await h.pay(token, s.quote, (await buildPaymentHeader(s.pr)).header);
    expect(r.body).toMatchObject({ state: "delivered", prepaidCreditsDebited: "0", result: { kind: "inference", provenance: { mode: "fixture" } } });
    const bal = await h.call("GET", "/credits/balance", token);
    expect(bal.body).toMatchObject({ issued: "0", reserved: "0", consumed: "0" });

    h.provider!.behavior = { kind: "text", text: "not json" };
    const input = { topic: "repair", audience: "locals", channels: ["LinkedIn", "Newsletter", "Instagram"], voice: "warm" };
    const c = await quoteAndChallenge(h, token, "content-package", input);
    const bad = await h.pay(token, c.quote, (await buildPaymentHeader(c.pr)).header);
    expect(bad.body.state).toBe("incomplete");
    expect(bad.body.result.issues[0]).toContain("not JSON");
    expect(h.provider!.calls).toHaveLength(2);

    h.provider!.behavior = { kind: "text", text: VALID_CONTENT };
    const c2 = await quoteAndChallenge(h, token, "content-package", input);
    const good = await h.pay(token, c2.quote, (await buildPaymentHeader(c2.pr)).header);
    expect(good.body.state).toBe("delivered");
    expect(good.body.result.drafts).toHaveLength(3);
    expect(good.body.result.calendar).toHaveLength(7);
  });

  it("an ambiguous paid provider call becomes paid_no_result with no second attempt", async () => {
    h = await makeHarness();
    const { token } = h.account();
    h.provider!.behavior = { kind: "ambiguous" };
    const s = await quoteAndChallenge(h, token, "analyze", { text: "abc" });
    const r = await h.pay(token, s.quote, (await buildPaymentHeader(s.pr)).header);
    expect(r.body).toMatchObject({ state: "paid_no_result", error: { code: "PAID_NO_RESULT" } });
    await h.call("GET", `/v1/purchases/${s.quote.quoteId}/result`, token);
    await h.gateway.recover();
    expect(h.provider!.calls).toHaveLength(1);
  });

  it("health reports database, facilitator and provider readiness without spending", async () => {
    h = await makeHarness();
    const report = h.gateway.health();
    expect(report).toMatchObject({ status: "ok", database: { ok: true, schemaVersion: 1 }, x402: { accepting: true }, provider: { mode: "fixture", ready: true } });
    expect(h.provider!.calls).toHaveLength(0);
  });
});
