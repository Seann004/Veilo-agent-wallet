import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_TOKEN_MINT, DEVNET_GENESIS_HASH, loadConfig } from "@veilo/contracts";
import { loadGatewayConfig } from "@veilo/contracts/gateway";
import { deriveAta } from "@veilo/x402-client";
import { gatewayRole, loadSellerHostConfig } from "../src/seller-host/config";
import { buildPaymentHeader, makeHarness, MINT, type Harness, type HarnessOptions } from "./harness";
import { FakeMarketplace } from "./marketplace-fake";

const SKU = "specialist-job";
const DELIVERABLE = "## Summary\nRepair cafes extend product life.\n\n## Key points\n- Fewer discarded appliances.";

let h: Harness | undefined;
let mk: FakeMarketplace | undefined;
afterEach(async () => {
  await h?.close();
  await mk?.close();
  h = undefined;
  mk = undefined;
});

const count = (table: string) => Number((h!.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: bigint }).n);

async function sellerHost(options: Omit<HarnessOptions, "sellerHost"> & { allowedRecipients?: string[] } = {}) {
  mk = await new FakeMarketplace().start();
  const { allowedRecipients, ...rest } = options;
  h = await makeHarness({ ...rest, sellerHost: { marketplaceUrl: mk.url, token: mk.token, ...(allowedRecipients ? { allowedRecipients } : {}) } });
  h.provider!.behavior = { kind: "text", text: DELIVERABLE };
  return { h, mk };
}

async function quoteJob(token: string, input: unknown, operationId?: string) {
  const q = await h!.quote(token, SKU, input, operationId);
  return { ...q, ref: { quoteId: q.body.quoteId as string, operationId: q.operationId, requestDigest: q.requestDigest } };
}

async function payJob(token: string, input: unknown) {
  const q = await quoteJob(token, input);
  expect(q.status).toBe(201);
  const c = await h!.challenge(token, q.ref);
  expect(c.status).toBe(402);
  const { header } = await buildPaymentHeader(c.paymentRequired!);
  return { q, c, header };
}

describe("seller-host quotes", () => {
  it("takes amount, recipient and expiry from the verified marketplace quote, never the operator merchant", async () => {
    await sellerHost();
    const { token } = h!.account();
    const job = await mk!.addJob();
    const q = await quoteJob(token, job.input);
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({
      sku: SKU,
      charge: { amount: "250000", unit: "usdc_base_units" },
      recipient: { payTo: mk!.recipient.address, merchantAta: await deriveAta(mk!.recipient.address, MINT) },
      gateway: { identity: "veilo-seller-host-devnet", origin: "http://127.0.0.1:4106" },
      usageLimits: { maxOutputTokens: 1_500 },
    });
    expect(q.body.recipient.payTo).not.toBe(h!.merchant.address);
    expect(Date.parse(q.body.expiresAt)).toBeLessThanOrEqual(Date.parse(job.quote.expiresAt));
    const c = await h!.challenge(token, q.ref);
    expect(c.paymentRequired!.accepts[0]).toMatchObject({ payTo: mk!.recipient.address, amount: "250000", asset: MINT });
    expect(c.paymentRequired!.resource.serviceName).toBe("veilo-seller-host-devnet");
  });

  it("rejects each mismatched or tampered field with a definite code and creates no quote", async () => {
    await sellerHost();
    const { token } = h!.account();
    const other = await mk!.addJob();
    const cases: Array<[string, Parameters<FakeMarketplace["addJob"]>[0], (i: Record<string, string>) => Record<string, string>, string]> = [
      ["quote digest", {}, (i) => ({ ...i, quoteDigest: "c".repeat(64) }), "PRICE_CHANGED"],
      ["listing version", {}, (i) => ({ ...i, listingVersionId: other.input.listingVersionId }), "PRICE_CHANGED"],
      ["brief", {}, (i) => ({ ...i, brief: "A different brief" }), "PRICE_CHANGED"],
      ["quote job", { fields: { jobId: other.jobId } }, (i) => i, "PRICE_CHANGED"],
      ["tampered amount", { tamper: { totalUnits: "1" } }, (i) => i, "PRICE_CHANGED"],
      ["tampered recipient", { tamper: { recipient: MINT } }, (i) => i, "PRICE_CHANGED"],
      ["runtime version", { fields: { runtimeVersion: "managed:research-summary:v0" } }, (i) => i, "PRICE_CHANGED"],
      ["network", { fields: { network: "solana:otherdevnetcluster" } }, (i) => i, "WRONG_NETWORK"],
      ["genesis", { fields: { genesisHash: "11111111111111111111111111111111" } }, (i) => i, "WRONG_NETWORK"],
      ["mint", { fields: { mint: "So11111111111111111111111111111111111111112" } }, (i) => i, "WRONG_MINT"],
      ["decimals", { fields: { decimals: 9 } }, (i) => i, "WRONG_MINT"],
      ["recipient ATA", { fields: { recipientAta: mk!.recipient.address } }, (i) => i, "SERVICE_NOT_ALLOWED"],
      ["seller origin", { fields: { sellerOrigin: "https://other-seller.example" } }, (i) => i, "SERVICE_NOT_ALLOWED"],
      ["seller identity", { fields: { sellerIdentity: "someone-else" } }, (i) => i, "SERVICE_NOT_ALLOWED"],
      ["remote runtime", { runtime: { kind: "remote_endpoint", template: null } }, (i) => i, "SERVICE_NOT_ALLOWED"],
      ["json output", { runtime: { outputFormat: "json" } }, (i) => i, "SERVICE_NOT_ALLOWED"],
      ["unpinned model", { runtime: { modelId: "openai/gpt-4o" } }, (i) => i, "SERVICE_NOT_ALLOWED"],
      ["free quote", { fields: { baseUnits: "0", totalUnits: "0" } }, (i) => i, "SERVICE_NOT_ALLOWED"],
    ];
    for (const [name, setup, mutate, code] of cases) {
      const job = await mk!.addJob(setup);
      const r = await quoteJob(token, mutate(job.input));
      expect({ name, code: r.body.error?.code }).toEqual({ name, code });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    expect(count("quotes")).toBe(0);
    expect(count("seller_jobs")).toBe(0);
  });

  it("refuses a recipient outside the configured payout allowlist", async () => {
    mk = await new FakeMarketplace().start();
    h = await makeHarness({ sellerHost: { marketplaceUrl: mk.url, token: mk.token, allowedRecipients: [MINT] } });
    const r = await quoteJob(h.account().token, (await mk.addJob()).input);
    expect(r.body.error.code).toBe("SERVICE_NOT_ALLOWED");
  });

  it("refuses a job that is not awaiting payment, an expired quote, and an unreachable marketplace", async () => {
    await sellerHost();
    const { token } = h!.account();
    const queued = await mk!.addJob({ state: "queued" });
    expect((await quoteJob(token, queued.input)).body.error.code).toBe("NOT_READY");
    const expired = await mk!.addJob({ expiresAt: new Date(h!.clock.t - 1) });
    const e = await quoteJob(token, expired.input);
    expect(e.status).toBe(410);
    expect(e.body.error.code).toBe("QUOTE_EXPIRED");
    const missing = await quoteJob(token, { ...queued.input, jobId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" });
    expect(missing.status).toBe(404);
    const fine = await mk!.addJob();
    mk!.down = true;
    const down = await quoteJob(token, fine.input);
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("NOT_READY");
    expect(count("quotes")).toBe(0);
  });

  it("issues no challenge and takes no payment once the job stops awaiting payment", async () => {
    await sellerHost();
    const { token } = h!.account();
    const job = await mk!.addJob();
    const q = await quoteJob(token, job.input);
    const c = await h!.challenge(token, q.ref);
    const { header } = await buildPaymentHeader(c.paymentRequired!);
    mk!.job(job.jobId).view.state = "cancelled";
    const r = await h!.pay(token, q.ref, header);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("NOT_READY");
    expect(h!.facilitator.verifyCalls + h!.facilitator.settleCalls).toBe(0);
    expect(count("payment_attempts")).toBe(0);
  });

  it("binds one job to one buyer operation", async () => {
    await sellerHost();
    const job = await mk!.addJob();
    expect((await quoteJob(h!.account().token, job.input)).status).toBe(201);
    const second = await quoteJob(h!.account().token, job.input);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("role separation", () => {
  it("the operator gateway refuses specialist-job and has no self-service accounts", async () => {
    mk = await new FakeMarketplace().start();
    h = await makeHarness();
    const job = await mk.addJob();
    const r = await h.quote(h.account().token, SKU, job.input);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("SERVICE_NOT_ALLOWED");
    expect((await h.call("POST", "/v1/accounts", undefined)).status).toBe(404);
    expect(mk.unauthorized + [...mk.jobs.values()].reduce((n, j) => n + j.claims, 0)).toBe(0);
  });

  it("the seller host refuses credit packs, datasets, inference SKUs, prepaid usage and planning", async () => {
    await sellerHost();
    const { token } = h!.account();
    for (const [sku, input] of [
      ["inference-credit-pack", { packs: 1 }],
      ["research-basic", { query: "q" }],
      ["summarize", { text: "t" }],
    ] as const) {
      const r = await h!.quote(token, sku, input);
      expect(r.body.error.code).toBe("SERVICE_NOT_ALLOWED");
    }
    for (const [method, path] of [
      ["GET", "/credits/balance"],
      ["POST", "/usage/authorize"],
      ["GET", "/usage/op-1"],
      ["POST", "/planning/complete"],
    ] as const) {
      const r = await h!.call(method, path, token, method === "POST" ? {} : undefined);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("SERVICE_NOT_ALLOWED");
    }
    expect(h!.gateway.health()).toMatchObject({ role: "seller-host", x402: { accepting: true, merchantAddress: null }, catalog: [{ sku: SKU }] });
  });
});

describe("seller-host fulfilment", () => {
  it("one payment yields evidence, one claim, one inference and one completion; retries return the stored result", async () => {
    await sellerHost();
    const { token } = h!.account();
    const job = await mk!.addJob();
    const { q, header } = await payJob(token, job.input);
    const [a, b] = await Promise.all([h!.pay(token, q.ref, header), h!.pay(token, q.ref, header)]);
    for (const r of [a, b]) expect(r.body.state).toBe("delivered");
    const fake = mk!.job(job.jobId);
    expect(fake.evidence).toHaveLength(1);
    expect(fake.evidence[0]!.operationId).toBe(job.quote.operationId);
    expect(fake.grants).toBe(1);
    expect(fake.completes).toHaveLength(1);
    expect(fake.completes[0]!.texts).toEqual([DELIVERABLE]);
    expect(fake.completes[0]!.envelope).toMatchObject({ jobId: job.jobId, status: "complete", schemaVersion: "veilo.result.v1" });
    expect(fake.heartbeats).toBeGreaterThanOrEqual(1);
    const sha = createHash("sha256").update(DELIVERABLE, "utf8").digest("hex");
    expect(a.body.result).toMatchObject({
      kind: "specialist_job",
      jobId: job.jobId,
      status: "complete",
      summary: "Repair cafes extend product life.",
      artifacts: [{ sha256: sha, bytes: Buffer.byteLength(DELIVERABLE), mimeType: "text/markdown" }],
      provenance: { mode: "fixture" },
    });
    const again = await h!.call("GET", `/v1/purchases/${q.ref.quoteId}/result`, token);
    expect(again.body.result).toEqual(a.body.result);
    await h!.gateway.recover();
    expect(h!.facilitator.settleCalls).toBe(1);
    expect(h!.provider!.calls).toHaveLength(1);
    expect(fake.claims).toBe(1);
    expect(fake.completes).toHaveLength(1);
    const system = h!.provider!.calls[0]!.messages[0]!.content;
    expect(system).toContain("untrusted data");
    expect(system).not.toContain(job.input.brief);
    expect(h!.provider!.calls[0]!.maxOutputTokens).toBe(1_500);
  });

  it("a crash between payment and claim resumes once after restart, even with duplicate executes", async () => {
    let crash = true;
    await sellerHost({ hooks: { afterPaymentFinalized: () => { if (crash) throw new Error("simulated crash"); } } });
    const { token } = h!.account();
    const job = await mk!.addJob();
    const { q, header } = await payJob(token, job.input);
    expect((await h!.pay(token, q.ref, header)).status).toBe(500);
    expect(count("payment_events")).toBe(1);
    expect(mk!.job(job.jobId).evidence).toHaveLength(0);
    expect(mk!.job(job.jobId).claims).toBe(0);

    crash = false;
    const shared = { chain: h!.chain, facilitator: h!.facilitator, merchant: h!.merchant, clock: h!.clock, permitPem: h!.permitPem };
    const dbPath = h!.dbPath;
    const provider = h!.provider!;
    await h!.close();
    h = await makeHarness({ dbPath, shared, provider, sellerHost: { marketplaceUrl: mk!.url, token: mk!.token } });
    await Promise.all([
      h.gateway.recover(),
      h.pay(token, q.ref, header),
      h.pay(token, q.ref, header),
      h.call("POST", `/v1/purchases/${q.ref.quoteId}/execute`, token, { operationId: q.ref.operationId, requestDigest: q.ref.requestDigest }),
      h.call("GET", `/v1/purchases/${q.ref.quoteId}/result`, token),
    ]);
    const final = await h.call("GET", `/v1/purchases/${q.ref.quoteId}/result`, token);
    expect(final.body.state).toBe("delivered");
    const fake = mk!.job(job.jobId);
    expect(fake.evidence).toHaveLength(1);
    expect(fake.grants).toBe(1);
    expect(fake.completes).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    expect(h.facilitator.settleCalls).toBe(1);
    expect(count("seller_fulfilments")).toBe(1);
  });

  it("retries the claim with backoff until the marketplace queues the job", async () => {
    await sellerHost();
    const { token } = h!.account();
    const job = await mk!.addJob();
    mk!.notQueuedClaims = 2;
    const { q, header } = await payJob(token, job.input);
    expect((await h!.pay(token, q.ref, header)).body.state).toBe("delivered");
    expect(mk!.job(job.jobId).claims).toBe(3);
    expect(mk!.job(job.jobId).grants).toBe(1);
  });

  it("stays visibly paid while the job cannot be claimed, then completes on a later pass", async () => {
    await sellerHost();
    const { token } = h!.account();
    const job = await mk!.addJob();
    mk!.notQueuedClaims = 10;
    const { q, header } = await payJob(token, job.input);
    const pending = await h!.pay(token, q.ref, header);
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ state: "paid_fulfilment_pending", payment: { txSignature: expect.any(String) } });
    expect(h!.provider!.calls).toHaveLength(0);
    mk!.notQueuedClaims = 0;
    const done = await h!.call("GET", `/v1/purchases/${q.ref.quoteId}/result`, token);
    expect(done.body.state).toBe("delivered");
    expect(mk!.job(job.jobId).grants).toBe(1);
  });

  it("an uncertain inference is reported uncertain once and never retried, including after restart", async () => {
    await sellerHost();
    const { token } = h!.account();
    h!.provider!.behavior = { kind: "ambiguous" };
    const job = await mk!.addJob();
    const { q, header } = await payJob(token, job.input);
    const r = await h!.pay(token, q.ref, header);
    expect(r.body).toMatchObject({ state: "paid_no_result", error: { code: "PAID_NO_RESULT" }, result: { status: "uncertain" } });
    expect(mk!.job(job.jobId).fails).toEqual([{ code: "PROVIDER_UNCERTAIN", uncertain: true }]);
    h!.provider!.behavior = { kind: "text", text: DELIVERABLE };
    await h!.call("GET", `/v1/purchases/${q.ref.quoteId}/result`, token);
    await h!.pay(token, q.ref, header);
    await h!.gateway.recover();
    expect(h!.provider!.calls).toHaveLength(1);
    expect(mk!.job(job.jobId).fails).toHaveLength(1);
    expect(mk!.job(job.jobId).completes).toHaveLength(0);
  });

  it("a crash during the provider call becomes uncertain on restart without a second provider call", async () => {
    let crash = true;
    await sellerHost({ hooks: { beforeProviderCall: () => { if (crash) throw new Error("simulated crash"); } } });
    const { token } = h!.account();
    const job = await mk!.addJob();
    const { q, header } = await payJob(token, job.input);
    expect((await h!.pay(token, q.ref, header)).status).toBe(500);
    crash = false;
    const shared = { chain: h!.chain, facilitator: h!.facilitator, merchant: h!.merchant, clock: h!.clock, permitPem: h!.permitPem };
    const dbPath = h!.dbPath;
    const provider = h!.provider!;
    await h!.close();
    h = await makeHarness({ dbPath, shared, provider, sellerHost: { marketplaceUrl: mk!.url, token: mk!.token } });
    await h.gateway.recover();
    const r = await h.call("GET", `/v1/purchases/${q.ref.quoteId}/result`, token);
    expect(r.body.state).toBe("paid_no_result");
    expect(provider.calls).toHaveLength(0);
    expect(mk!.job(job.jobId).fails).toEqual([{ code: "PROVIDER_UNCERTAIN", uncertain: true }]);
  });

  it("a definite provider failure is reported as a certain failure", async () => {
    await sellerHost();
    const { token } = h!.account();
    h!.provider!.behavior = { kind: "definite", status: 400 };
    const job = await mk!.addJob();
    const { q, header } = await payJob(token, job.input);
    expect((await h!.pay(token, q.ref, header)).body.state).toBe("paid_no_result");
    expect(mk!.job(job.jobId).fails).toEqual([{ code: "PROVIDER_FAILED", uncertain: false }]);
  });

  it("a lease lost before completion is re-claimed and the stored output is reported without re-running inference", async () => {
    await sellerHost();
    const { token } = h!.account();
    const job = await mk!.addJob();
    mk!.revokeLeaseBeforeComplete = 1;
    const { q, header } = await payJob(token, job.input);
    expect((await h!.pay(token, q.ref, header)).body.state).toBe("delivered");
    const fake = mk!.job(job.jobId);
    expect(fake.grants).toBe(2);
    expect(fake.completes).toHaveLength(1);
    expect(fake.completes[0]!.envelope).toMatchObject({ leaseGeneration: 2 });
    expect(h!.provider!.calls).toHaveLength(1);
  });

  it("missing listing sections mark the result incomplete", async () => {
    await sellerHost();
    const { token } = h!.account();
    h!.provider!.behavior = { kind: "text", text: "## Summary\nOnly one section." };
    const job = await mk!.addJob();
    const { q, header } = await payJob(token, job.input);
    const r = await h!.pay(token, q.ref, header);
    expect(r.body).toMatchObject({ state: "incomplete", result: { status: "incomplete", missingSections: ["Key points"] } });
    expect(mk!.job(job.jobId).completes[0]!.envelope).toMatchObject({ status: "incomplete" });
  });

  it.each([
    [403, { error: { code: "SERVICE_NOT_ALLOWED", message: "receipt was not authorized by this operation's payer" } }, "SERVICE_NOT_ALLOWED"],
    [403, { error: "forbidden" }, "SERVICE_NOT_ALLOWED"],
    [400, { error: { code: "INVALID_REQUEST", message: "bad evidence" } }, "INVALID_REQUEST"],
  ])("a refused payment evidence (HTTP %i) closes the purchase as paid without a result, without claiming or running inference", async (status, body, code) => {
    await sellerHost();
    const { token } = h!.account();
    const job = await mk!.addJob();
    mk!.evidenceReplies = [{ status, body }];
    const { q, header } = await payJob(token, job.input);
    const r = await h!.pay(token, q.ref, header);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "paid_no_result", payment: { txSignature: expect.any(String) }, result: { status: "evidence_refused", code } });
    expect(h!.db.prepare("SELECT error_code FROM purchases").pluck().get()).toBe(code);
    const again = await h!.call("GET", `/v1/purchases/${q.ref.quoteId}/result`, token);
    expect(again.body.state).toBe("paid_no_result");
    const fake = mk!.job(job.jobId);
    expect(fake.evidence).toHaveLength(0);
    expect(fake.claims).toBe(0);
    expect(h!.provider!.calls).toHaveLength(0);
    expect(h!.facilitator.settleCalls).toBe(1);
  });

  it.each([202, 401, 429, 503])("an HTTP %i evidence reply keeps the purchase paid and retries on the next pass", async (status) => {
    await sellerHost();
    const { token } = h!.account();
    const job = await mk!.addJob();
    mk!.evidenceReplies = [{ status, body: { error: { code: "NOT_READY", message: "later" } } }];
    const { q, header } = await payJob(token, job.input);
    const r = await h!.pay(token, q.ref, header);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ error: { code: "NOT_READY" } });
    expect((await h!.call("GET", `/v1/purchases/${q.ref.quoteId}/result`, token)).body.state).toBe("delivered");
    expect(mk!.job(job.jobId).evidence).toHaveLength(1);
  });

  it("keeps the payment while the marketplace is unreachable after settlement and reports evidence once it returns", async () => {
    await sellerHost({ hooks: { afterClaim: () => { mk!.down = true; } } });
    const { token } = h!.account();
    const job = await mk!.addJob();
    const { q, header } = await payJob(token, job.input);
    const r = await h!.pay(token, q.ref, header);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ state: "paid_awaiting_provider", error: { code: "NOT_READY" } });
    mk!.down = false;
    expect((await h!.call("GET", `/v1/purchases/${q.ref.quoteId}/result`, token)).body.state).toBe("delivered");
    expect(mk!.job(job.jobId).evidence).toHaveLength(1);
    expect(h!.facilitator.settleCalls).toBe(1);
  });
});

describe("seller-host buyer accounts", () => {
  it("issues scoped tokens, rate-limits per address and never exposes another account's quote", async () => {
    await sellerHost({ accountRateLimit: { perIp: 2, global: 100, windowMs: 60_000 } });
    const a = await h!.call("POST", "/v1/accounts", undefined);
    const b = await h!.call("POST", "/v1/accounts", undefined);
    expect(a.status).toBe(201);
    expect(a.body.token).toMatch(/^vga_/);
    expect(a.body.accountId).not.toBe(b.body.accountId);
    expect((await h!.call("POST", "/v1/accounts", undefined)).status).toBe(429);
    h!.clock.advance(60_001);
    expect((await h!.call("POST", "/v1/accounts", undefined)).status).toBe(201);

    const job = await mk!.addJob();
    const q = await quoteJob(a.body.token, job.input);
    expect(q.status).toBe(201);
    expect((await h!.call("GET", `/v1/purchases/${q.ref.quoteId}/result`, b.body.token)).status).toBe(404);
    const exec = await h!.call("POST", `/v1/purchases/${q.ref.quoteId}/execute`, b.body.token, { operationId: q.ref.operationId, requestDigest: q.ref.requestDigest });
    expect(exec.status).toBe(404);
    expect((await h!.call("GET", `/v1/purchases/${q.ref.quoteId}/result`, undefined)).status).toBe(401);
    const own = await h!.challenge(a.body.token, q.ref);
    expect(own.status).toBe(402);
  });
});

describe("seller-host configuration", () => {
  const base = () =>
    loadConfig({ DEVNET_RPC_URL: "https://rpc.test.invalid", EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH, DEMO_TOKEN_MINT, FACILITATOR_URL: "https://facilitator.test.invalid" });
  const env = { GATEWAY_ROLE: "seller-host", MARKETPLACE_URL: "https://market.example", MARKETPLACE_SELLER_HOST_TOKEN: "t".repeat(32) };

  it("defaults to its own identity, port, origin and database", () => {
    const c = base();
    const host = loadSellerHostConfig(c, loadGatewayConfig(c, {}), env);
    expect(host).toMatchObject({ identity: "veilo-seller-host-devnet", port: 4106, publicOrigin: "http://127.0.0.1:4106", allowedRecipients: [] });
    expect(host.databasePath).not.toBe(c.paths.gatewayDatabase);
    expect(gatewayRole({})).toBe("operator");
    expect(gatewayRole(env)).toBe("seller-host");
  });

  it("fails closed on shared identity, origin, database or port, plaintext marketplace URLs and a missing token", () => {
    const c = base();
    const gw = loadGatewayConfig(c, {});
    for (const extra of [
      { SELLER_HOST_IDENTITY: gw.identity },
      { SELLER_HOST_PUBLIC_ORIGIN: gw.publicOrigin },
      { SELLER_HOST_DATABASE_PATH: c.paths.gatewayDatabase },
      { SELLER_HOST_PORT: String(c.ports.gateway) },
      { MARKETPLACE_URL: "http://market.example" },
      { MARKETPLACE_SELLER_HOST_TOKEN: "" },
      { SELLER_HOST_RECIPIENTS: "not-an-address" },
      { GATEWAY_ROLE: "merchant" },
    ]) {
      expect(() => loadSellerHostConfig(c, gw, { ...env, ...extra })).toThrow(/seller-host configuration|GATEWAY_ROLE/);
    }
    expect(loadSellerHostConfig(c, gw, { ...env, MARKETPLACE_URL: "http://127.0.0.1:6199" }).marketplaceUrl).toBe("http://127.0.0.1:6199");
  });
});
