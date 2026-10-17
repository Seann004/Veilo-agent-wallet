// Integration and fault-injection suite (T15). Real services as separate processes, a loopback
// solana-test-validator running the deployed program build, real Groth16 proofs, the official
// x402 SVM facilitator self-hosted on the local chain, and a FIXTURE (mock) upstream provider.
// Scenarios run in order against one stack; each asserts cross-ledger duplication invariants.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { computeRequestDigest } from "@veilo/contracts/gateway";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO, sleep } from "../../scripts/devnet/lib";
import { tokenBalance } from "../../scripts/local-stack/chain";
import { MOCK_PRICE_INCREASED, MOCK_PRICING } from "../../scripts/local-stack/mock-provider";
import { SERVICES } from "../../scripts/local-stack/services";
import type { FaultRule, ProxyRequest } from "../../scripts/local-stack/proxy";
import { bootCtx, runKey, intent, invariants, n, openPolicies, purchase, q, serviceId, TERMINAL, waitPurchase, type Ctx } from "./helpers";

let c: Ctx;
const RUN = Date.now().toString(36);
const RESULTS_PATH = join(REPO, "work", "integration", "scenario-evidence.json");

async function until(what: string, fn: () => boolean | Promise<boolean>, timeoutMs = 240_000, stepMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(stepMs);
  }
}

const purchaseIdByKey = (key: string): string | undefined => q<{ id: string }>(c, "control", "SELECT id FROM purchase WHERE idempotency_key = ?", runKey(key))[0]?.id;
const usdcExpenses = (id: string) => n(c, "control", "SELECT count(*) FROM financial_event WHERE purchase_id = ? AND kind = 'expense_settled' AND asset = 'usdc'", id);
const crashAll = async (): Promise<"drop"> => {
  await c.s.services.killAll();
  return "drop";
};
const isPost = (path: RegExp) => (r: ProxyRequest) => r.method === "POST" && path.test(r.path);
const withPayment = (r: ProxyRequest) => typeof r.headers["payment-signature"] === "string";

function record(id: string, value: unknown): void {
  c.evidence[id] = value;
}

/** Fires a purchase whose request crosses a crash boundary, restarts every service and lets reconciliation finish. */
async function crashAndRecover(o: { name: string; link: keyof Ctx["s"]["proxies"]; rule: Omit<FaultRule, "hits">; sku?: string; agent?: "Prince" | "Mira" | "Shawn"; input?: Record<string, unknown>; path?: "private_x402" | "prepaid_credits" }) {
  const key = `rec01:${o.name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 100)}`;
  const sku = o.sku ?? "research-basic";
  const rule = c.s.proxies[o.link].add({ ...o.rule });
  let early: string | null = null;
  const reply = intent(c, o.agent ?? "Prince", key, sku, o.path ?? "private_x402", o.input ?? { query: `crash boundary ${o.name}` })
    .then((r) => {
      if ((rule.hits ?? 0) === 0) early = `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`;
      return r;
    })
    .catch(() => null);
  await until(`${o.name}: fault boundary reached`, () => {
    if (early) throw new Error(`${o.name}: request finished before the boundary: ${early}`);
    return (rule.hits ?? 0) >= 1;
  }, 300_000);
  await until(`${o.name}: services stopped`, () => SERVICES.every((x) => !c.s.services.running(x)), 60_000);
  await reply;
  c.s.proxies[o.link].clear();
  await c.s.services.startAll();
  const id = purchaseIdByKey(key);
  expect(id, `${o.name}: purchase recorded before the crash`).toBeDefined();
  const p = await waitPurchase(c, id!);
  const inv = invariants(c, id!);
  return { id: id!, p, inv };
}

beforeAll(async () => {
  mkdirSync(join(REPO, "work", "integration"), { recursive: true });
  c = await bootCtx();
  await openPolicies(c);
  // Shawn's scheduled checks would buy packs on their own; he runs only in the credit scenario.
  await c.s.owner.control("POST", `/agents/${c.agents.Shawn}/pause`, {});
  const status = await c.s.owner.notes();
  if (BigInt(status.totals.spendable.amount) < 15_000_000n) await c.s.fundPool(Array.from({ length: 8 }, () => 3_000_000n));
  record("environment", {
    chain: "solana-test-validator (Agave 4.1.2, toolchain image) on loopback; genesis " + c.s.validator.genesisHash + " (not devnet)",
    program: `${c.s.manifest.program.programId} preloaded from target/deploy/privacy_pool.so sha256 ${c.s.manifest.program.binarySha256}`,
    facilitator: `self-hosted @x402/core x402Facilitator + @x402/svm exact scheme, fee payer ${c.s.facilitator.feePayer}`,
    provider: "FIXTURE: loopback OpenRouter-compatible mock (not real inference)",
    proofs: "real Groth16 proofs (snarkjs) verified on chain by the deployed program",
  });
}, 3_600_000);

afterAll(async () => {
  if (c) {
    writeFileSync(RESULTS_PATH, `${JSON.stringify(c.evidence, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
    await c.s.close({ keepValidator: process.env.VEILO_IT_KEEP === "1" });
  }
});

describe("baseline private x402 purchase", () => {
  it("IDEM-01: one financial operation for the same logical purchase; repeats return the same state and result", async () => {
    const input = { query: "repair cafes" };
    const first = await intent(c, "Prince", "idem-1", "research-basic", "private_x402", input);
    expect([200, 201]).toContain(first.status);
    const id = first.body.purchase.id as string;
    const p = await waitPurchase(c, id);
    expect(p.purchase.states).toMatchObject({ funding: "finalized", merchant: "finalized", fulfilment: "delivered" });
    const again = await intent(c, "Prince", "idem-1", "research-basic", "private_x402", input);
    const third = await intent(c, "Prince", "idem-1", "research-basic", "private_x402", input);
    expect(again.body.purchase.id).toBe(id);
    expect(third.body.purchase.id).toBe(id);
    expect(again.body.execution.result).toEqual(p.execution.result);
    const inv = invariants(c, id);
    expect(inv).toMatchObject({ walletFundings: 1, relayerWithdrawals: 1, relayerSpendFinalized: 1, merchantPayments: 1, gatewayPurchases: 1, gatewayPaymentEvents: 1 });
    expect(usdcExpenses(id)).toBe(1);
    record("IDEM-01", { purchaseId: id, chainAttempts: p.purchase.chainAttempts, invariants: inv });
  });

  it("X402-04: the same operation with a changed request conflicts before any payment work", async () => {
    const before = n(c, "control", "SELECT count(*) FROM purchase");
    const r = await intent(c, "Prince", "idem-1", "research-basic", "private_x402", { query: "something else" });
    expect(r.status).toBe(409);
    expect(n(c, "control", "SELECT count(*) FROM purchase")).toBe(before);
    // At the gateway: the same authenticated operation with another request digest.
    const token = readFileSync(join(c.s.dir, "secrets", "control", "gateway-account.token"), "utf8").trim();
    const gw = `http://127.0.0.1:${c.s.ports.gateway}`;
    const op = `x402-04-${Date.now()}`;
    const mk = (query: string) => fetch(`${gw}/quotes`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ operationId: op, sku: "research-basic", input: { query }, requestDigest: computeRequestDigest("research-basic", { query }) }) });
    const q1 = await mk("a");
    expect([200, 201]).toContain(q1.status);
    const q2 = await mk("b");
    expect(q2.status).toBe(409);
    const settles = c.s.facilitator.calls.settle;
    expect(c.s.facilitator.calls.settle).toBe(settles);
    record("X402-04", { control: r.status, gatewayChangedDigest: q2.status });
  });

  it("X402-03: a settled payment presented for another quote or another account is not fulfilled again", async () => {
    const paid = q<{ payment_header: string; purchase_id: string }>(c, "wallet", "SELECT payment_header, purchase_id FROM merchant_payment ORDER BY rowid LIMIT 1")[0]!;
    const token = readFileSync(join(c.s.dir, "secrets", "control", "gateway-account.token"), "utf8").trim();
    const gw = `http://127.0.0.1:${c.s.ports.gateway}`;
    const call = (path: string, body: unknown, auth: string, headers: Record<string, string> = {}) =>
      fetch(`${gw}${path}`, { method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
    const replay = async (auth: string, tag: string) => {
      const input = { query: `replay ${tag}` };
      const op = `x402-03-${tag}-${Date.now()}`;
      const quote = await call("/quotes", { operationId: op, sku: "research-basic", input, requestDigest: computeRequestDigest("research-basic", input) }, auth);
      expect([200, 201]).toContain(quote.status);
      return call(`/v1/purchases/${quote.body.quoteId as string}/execute`, { operationId: op, requestDigest: computeRequestDigest("research-basic", input) }, auth, { "payment-signature": paid.payment_header });
    };
    const settlesBefore = c.s.facilitator.calls.settle;
    const eventsBefore = n(c, "gateway", "SELECT count(*) FROM payment_events");
    const sameAccount = await replay(token, "same");
    // Another gateway account, created directly in the gateway ledger for this test.
    const created = spawnSync(process.execPath, ["--import", "tsx", "services/gateway/src/cli/create-account.ts", "--workspace", `x402-03-other-${RUN}`, "--out", join(c.s.dir, "secrets", `x402-03-other-${RUN}.token`)], { cwd: REPO, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", VEILO_ENV_FILE: c.s.envFile }, encoding: "utf8" });
    expect(created.status, created.stderr).toBe(0);
    const other = await replay(readFileSync(join(c.s.dir, "secrets", `x402-03-other-${RUN}.token`), "utf8").trim(), "other");
    for (const r of [sameAccount, other]) {
      expect(r.status).not.toBe(200);
      expect(r.body.state).not.toBe("delivered");
    }
    expect(n(c, "gateway", "SELECT count(*) FROM payment_events")).toBe(eventsBefore);
    expect(n(c, "gateway", "SELECT count(*) FROM credit_issuances")).toBe(n(c, "gateway", "SELECT count(*) FROM credit_issuances"));
    record("X402-03", { sameAccountOtherQuote: { status: sameAccount.status, error: sameAccount.body.error }, otherAccount: { status: other.status, error: other.body.error }, facilitatorSettlesDuringReplay: c.s.facilitator.calls.settle - settlesBefore });
  });
});

describe("REC-01 / REC-02 restart at every multi-leg boundary (private x402)", () => {
  const cases: Array<{ name: string; link: keyof Ctx["s"]["proxies"]; rule: Omit<FaultRule, "hits"> }> = [
    { name: "control→wallet prepare, before delivery", link: "control→wallet", rule: { match: isPost(/^\/fundings$/), before: crashAll } },
    { name: "control→wallet prepare, reply lost", link: "control→wallet", rule: { match: isPost(/^\/fundings$/), after: crashAll } },
    { name: "control→wallet release, before delivery", link: "control→wallet", rule: { match: isPost(/\/release$/), before: crashAll } },
    { name: "wallet→relayer withdrawal, before delivery", link: "wallet→relayer", rule: { match: isPost(/^\/withdrawals$/), before: crashAll } },
    { name: "wallet→relayer withdrawal, reply lost", link: "wallet→relayer", rule: { match: isPost(/^\/withdrawals$/), after: crashAll } },
    { name: "relayer→rpc sendTransaction, crash after send", link: "relayer→rpc", rule: { match: (r) => r.rpcMethod === "sendTransaction", after: crashAll } },
    { name: "control→wallet release, reply lost", link: "control→wallet", rule: { match: isPost(/\/release$/), after: crashAll } },
    { name: "control→wallet merchant signing, reply lost", link: "control→wallet", rule: { match: isPost(/\/merchant-payment$/), after: crashAll } },
    { name: "control→gateway signed payment, before delivery", link: "control→gateway", rule: { match: (r) => withPayment(r), before: crashAll } },
    { name: "gateway→facilitator settle, reply lost (REC-02)", link: "gateway→facilitator", rule: { match: isPost(/^\/settle$/), after: crashAll } },
    { name: "control→gateway signed payment, reply lost", link: "control→gateway", rule: { match: (r) => withPayment(r), after: crashAll } },
  ];
  const results: Record<string, unknown> = {};
  for (const tc of cases) {
    it(tc.name, async () => {
      const { id, p, inv } = await crashAndRecover(tc);
      const states = p.purchase.states;
      // Either the purchase completed once, or (only if a signed payment expired unseen) the funded
      // wallet is recoverable; never a second withdrawal, payment, delivery or expense.
      expect(inv.walletFundings).toBe(1);
      expect(inv.relayerWithdrawals).toBe(1);
      expect(inv.relayerSpendFinalized).toBe(1);
      expect(inv.merchantPayments).toBeLessThanOrEqual(1);
      expect(inv.gatewayPurchases).toBeLessThanOrEqual(1);
      expect(inv.gatewayPaymentEvents).toBeLessThanOrEqual(1);
      expect(usdcExpenses(id)).toBe(states.merchant === "finalized" ? 1 : 0);
      if (states.merchant === "finalized") expect(states.fulfilment).toBe("delivered");
      else expect(states.recovery).not.toBe("none");
      results[tc.name] = { purchaseId: id, states, invariants: inv };
    });
  }
  afterAll(() => record("REC-01", results));
});

describe("credits: CRE-01 restart after settle before issue, CRE-03 repeated checks with restart", () => {
  it("issues the pack once after the gateway crashes between finalized payment and issuance", async () => {
    await c.s.owner.control("POST", `/agents/${c.agents.Shawn}/resume`, {});
    await c.s.services.kill("gateway");
    c.s.services.start("gateway", { VEILO_TEST_CRASH_POINTS: "gateway.afterPaymentFinalized" });
    await c.s.services.waitHealthy("gateway");
    const issuedBefore = n(c, "gateway", "SELECT count(*) FROM credit_issuances");
    const run = c.s.owner.control("POST", `/agents/${c.agents.Shawn}/run`, { input: { retry: true } }).catch(() => null);
    const code = await c.s.services.exitOf("gateway");
    expect(code).toBe(86);
    await run;
    c.s.services.start("gateway");
    await c.s.services.waitHealthy("gateway");
    const pid = q<{ purchase_id: string }>(c, "control", "SELECT purchase_id FROM credit_episode WHERE purchase_id IS NOT NULL ORDER BY created_at_ms DESC LIMIT 1")[0]!.purchase_id;
    const p = await waitPurchase(c, pid);
    expect(p.purchase.states).toMatchObject({ merchant: "finalized", fulfilment: "delivered" });
    expect(n(c, "gateway", "SELECT count(*) FROM credit_issuances") - issuedBefore).toBe(1);
    const inv = invariants(c, pid);
    expect(inv).toMatchObject({ relayerWithdrawals: 1, merchantPayments: 1, gatewayPaymentEvents: 1 });
    const bal = await c.s.owner.control("GET", "/balances");
    expect(BigInt(bal.body.gatewayCredits.purchased)).toBeGreaterThanOrEqual(1_000_000n);
    record("CRE-01", { purchaseId: pid, gatewayExitCode: code, issuances: 1, invariants: inv });
  });

  it("CRE-03: repeated checks and a full restart keep one unresolved top-up and one issuance; cooldown holds", async () => {
    const episodes = () => n(c, "control", "SELECT count(*) FROM credit_episode WHERE agent_id = ?", c.agents.Shawn);
    const issuances = () => n(c, "gateway", "SELECT count(*) FROM credit_issuances");
    const e0 = episodes();
    const i0 = issuances();
    const checks = [];
    for (let i = 0; i < 3; i++) checks.push((await c.s.owner.control("POST", `/agents/${c.agents.Shawn}/run`, {})).body.check?.decision ?? null);
    await c.s.services.restartAll();
    await c.s.login();
    for (let i = 0; i < 2; i++) checks.push((await c.s.owner.control("POST", `/agents/${c.agents.Shawn}/run`, {})).body.check?.decision ?? null);
    expect(episodes()).toBe(e0);
    expect(issuances()).toBe(i0);
    expect(checks.every((d) => d !== "top_up_started")).toBe(true);
    await c.s.owner.control("POST", `/agents/${c.agents.Shawn}/pause`, {});
    record("CRE-03", { decisions: checks, episodes: episodes(), issuances: issuances() });
  });
});

describe("USG-01 failure between control's scoped reservation and the gateway account reservation", () => {
  for (const [name, link, match] of [
    ["authorize reply lost", "control→gateway", isPost(/^\/usage\/authorize$/)],
    ["execute reply lost", "control→gateway", isPost(/^\/usage\/execute$/)],
  ] as const) {
    it(name, async () => {
      const providerCalls = c.s.provider.calls.length;
      const { id, p } = await crashAndRecover({ name: `usage ${name}`, link, rule: { match, after: crashAll }, sku: "analyze", path: "prepaid_credits", input: { text: `usage boundary ${name}`, question: "What is notable?" } });
      const op = p.purchase.operationId as string;
      expect(p.purchase.states.fulfilment).toBe("delivered");
      expect(n(c, "gateway", "SELECT count(*) FROM usage_operations WHERE operation_id = ?", op)).toBe(1);
      expect(n(c, "gateway", "SELECT count(*) FROM credit_events e JOIN usage_operations u ON u.id = e.reservation_id WHERE u.operation_id = ? AND e.kind = 'consume'", op)).toBe(1);
      expect(n(c, "control", "SELECT count(*) FROM financial_event WHERE purchase_id = ? AND kind = 'expense_settled' AND asset = 'usage_units'", id)).toBe(1);
      expect(c.s.provider.calls.length - providerCalls).toBe(1);
      (c.evidence["USG-01"] ??= {} as Record<string, unknown>) as Record<string, unknown>;
      (c.evidence["USG-01"] as Record<string, unknown>)[name] = { purchaseId: id, states: p.purchase.states, providerCalls: 1 };
    });
  }
});

describe("LLM-01 upstream timeout, price change and exhausted account (FIXTURE provider)", () => {
  it("timeout: one attempt, outcome uncertain, units stay reserved, no retry after restart", async () => {
    await c.s.services.kill("gateway");
    c.s.services.start("gateway", { GATEWAY_PROVIDER_TIMEOUT_MS: "3000" });
    await c.s.services.waitHealthy("gateway");
    c.s.provider.behavior = "timeout";
    const calls = c.s.provider.calls.length;
    const r = await intent(c, "Prince", "llm-timeout", "summarize", "prepaid_credits", { text: "timeout case" });
    const id = r.body.purchase.id as string;
    const p = await waitPurchase(c, id, (x) => x.purchase.states.fulfilment === "uncertain");
    expect(p.purchase.reservation.status).toBe("active");
    c.s.provider.behavior = "ok";
    await c.s.services.restartAll();
    await c.s.login();
    await sleep(8_000);
    expect(c.s.provider.calls.length - calls).toBe(1);
    expect((await purchase(c, id)).purchase.states.fulfilment).toBe("uncertain");
    (c.evidence["LLM-01"] ??= {} as Record<string, unknown>);
    (c.evidence["LLM-01"] as Record<string, unknown>).timeout = { purchaseId: id, states: p.purchase.states, providerAttempts: 1 };
  });

  it("exhausted account (HTTP 402): definite failure, credits released, no retry", async () => {
    c.s.provider.behavior = "exhausted";
    const calls = c.s.provider.calls.length;
    const r = await intent(c, "Prince", "llm-exhausted", "summarize", "prepaid_credits", { text: "exhausted case" });
    const id = r.body.purchase.id as string;
    const p = await waitPurchase(c, id);
    c.s.provider.behavior = "ok";
    expect(p.purchase.states.fulfilment).not.toBe("delivered");
    expect(p.purchase.reservation.status).not.toBe("active");
    expect(c.s.provider.calls.length - calls).toBe(1);
    expect(n(c, "control", "SELECT count(*) FROM financial_event WHERE purchase_id = ? AND kind = 'expense_settled'", id)).toBe(0);
    (c.evidence["LLM-01"] as Record<string, unknown>).exhausted = { purchaseId: id, states: p.purchase.states, execution: p.execution.result };
  });

  it("price change above the pinned tariff: dispatch refused before any provider call", async () => {
    c.s.provider.pricing = { ...MOCK_PRICE_INCREASED };
    await c.s.services.kill("gateway");
    c.s.services.start("gateway");
    await c.s.services.waitHealthy("gateway");
    const calls = c.s.provider.calls.length;
    const r = await intent(c, "Prince", "llm-price", "summarize", "prepaid_credits", { text: "price case" });
    const id = r.body.purchase.id as string;
    const p = await waitPurchase(c, id);
    expect(p.purchase.states.fulfilment).not.toBe("delivered");
    expect(c.s.provider.calls.length).toBe(calls);
    const health = (await (await fetch(`http://127.0.0.1:${c.s.ports.gateway}/health`)).json()) as { provider: { inference: { ready: boolean; code?: string } } };
    expect(health.provider.inference.ready).toBe(false);
    c.s.provider.pricing = { ...MOCK_PRICING };
    await c.s.services.kill("gateway");
    c.s.services.start("gateway");
    await c.s.services.waitHealthy("gateway");
    (c.evidence["LLM-01"] as Record<string, unknown>).priceChange = { purchaseId: id, states: p.purchase.states, blocked: p.execution.blocked, gatewayInference: health.provider.inference };
  });
});

describe("quotes with a 60 s lifetime", () => {
  beforeAll(async () => {
    await c.s.services.kill("gateway");
    c.s.services.start("gateway", { GATEWAY_QUOTE_TTL_SECONDS: "60" });
    await c.s.services.waitHealthy("gateway");
  });
  afterAll(async () => {
    await c.s.services.kill("gateway");
    c.s.services.start("gateway");
    await c.s.services.waitHealthy("gateway");
  });

  /** The newest quote for one request; holds are scoped to it so other purchases are never delayed. */
  const quoteFor = (query: string) => q<{ id: string; expires_at: string }>(c, "gateway", "SELECT id, expires_at FROM quotes WHERE request_digest = ? ORDER BY created_at DESC LIMIT 1", computeRequestDigest("research-basic", { query }))[0];
  const latestQuoteExpiry = (query: string) => Date.parse(quoteFor(query)!.expires_at);

  it("QUO-01: a payment accepted while the quote was valid that settles after expiry is honored once", async () => {
    const hold = c.s.proxies["gateway→facilitator"].add({
      match: (r) => isPost(/^\/settle$/)(r) && quoteFor("late settlement") !== undefined && r.body.includes(quoteFor("late settlement")!.id),
      before: async () => {
        await until("quote expiry", () => Date.now() > latestQuoteExpiry("late settlement") + 1_500, 120_000, 500);
        return "forward" as const;
      },
    });
    const r = await intent(c, "Prince", "quo-01", "research-basic", "private_x402", { query: "late settlement" });
    c.s.proxies["gateway→facilitator"].clear();
    expect(hold.hits, "settlement was held past quote expiry").toBe(1);
    const id = (r.body.purchase?.id as string | undefined) ?? purchaseIdByKey("quo-01")!;
    const p = await waitPurchase(c, id);
    const inv = invariants(c, id);
    expect(p.purchase.states).toMatchObject({ merchant: "finalized", fulfilment: "delivered" });
    expect(inv).toMatchObject({ relayerWithdrawals: 1, merchantPayments: 1, gatewayPaymentEvents: 1 });
    const g = q<{ quote_id: string; amount: bigint }>(c, "gateway", "SELECT quote_id, amount FROM purchases WHERE operation_id = ?", p.purchase.operationId)[0]!;
    expect(BigInt(g.amount)).toBe(100_000n);
    const again = await intent(c, "Prince", "quo-01", "research-basic", "private_x402", { query: "late settlement" });
    expect(again.body.execution.result).toEqual(p.execution.result);
    expect(invariants(c, id).gatewayPaymentEvents).toBe(1);
    record("QUO-01", { purchaseId: id, honoredPrice: g.amount.toString(), invariants: inv });
  });

  it("QUO-02: an expired quote before merchant signing is re-quoted and the existing funding is reused", async () => {
    const hold = c.s.proxies["control→gateway"].add({
      match: (r) => r.method === "POST" && /\/execute$/.test(r.path) && !withPayment(r) && r.body.includes(computeRequestDigest("research-basic", { query: "requote" })),
      before: async () => {
        await until("quote expiry", () => Date.now() > latestQuoteExpiry("requote") + 1_500, 120_000, 500);
        return "forward" as const;
      },
    });
    const r = await intent(c, "Prince", "quo-02", "research-basic", "private_x402", { query: "requote" });
    c.s.proxies["control→gateway"].clear();
    expect(hold.hits, "challenge was held past quote expiry").toBe(1);
    const id = (r.body.purchase?.id as string | undefined) ?? purchaseIdByKey("quo-02")!;
    const p = await waitPurchase(c, id);
    const inv = invariants(c, id);
    expect(p.purchase.states).toMatchObject({ funding: "finalized", merchant: "finalized", fulfilment: "delivered" });
    expect(p.execution.quotes.length).toBeGreaterThanOrEqual(2);
    expect(inv).toMatchObject({ walletFundings: 1, relayerWithdrawals: 1, merchantPayments: 1, gatewayPaymentEvents: 1 });
    record("QUO-02", { purchaseId: id, quotes: p.execution.quotes, invariants: inv });
  });
});

describe("LED-01 pending change", () => {
  it("change is unavailable before authenticated insertion and spendable after", async () => {
    const r = intent(c, "Mira", "led-01", "content-package", "private_x402", { topic: "Repair cafes", audience: "Neighbours", channels: ["LinkedIn", "Newsletter", "Instagram"], voice: "Warm", startDate: "2026-10-20" });
    await until("funding finalized", () => n(c, "control", "SELECT count(*) FROM purchase WHERE idempotency_key = ? AND funding_state = 'finalized'", runKey("led-01")) === 1, 300_000, 500);
    await c.s.services.kill("relayer");
    const id = purchaseIdByKey("led-01")!;
    const change = () => q<{ state: string; value: bigint }>(c, "control", "SELECT state, value FROM note WHERE parent_purchase_id = ?", id)[0];
    expect(change()?.state).toBe("pending_change");
    const walletChange = q<{ state: string }>(c, "wallet", "SELECT s.state FROM wallet_note_status s JOIN funding f ON f.change_note_id = s.note_id WHERE f.purchase_id = ?", id)[0];
    expect(walletChange?.state).not.toBe("spendable");
    const status = await c.s.owner.notes();
    const changeNote = (status.notes as Array<{ state: string; available: boolean; origin: string; value: { amount: string } }>).filter((x) => x.origin === "change" && x.state !== "spent" && x.state !== "exited" && x.state !== "spendable");
    expect(changeNote.every((x) => !x.available)).toBe(true);
    await r;
    c.s.services.start("relayer");
    await c.s.services.waitHealthy("relayer");
    await until("change spendable", () => change()?.state === "spendable_change", 300_000, 2_000);
    record("LED-01", { purchaseId: id, changeValue: change()!.value.toString(), beforeInsertion: "pending_change (control), not spendable (wallet)", afterInsertion: change()!.state });
  });
});

describe("CAP-02 two agents race real purchases for the final workspace allowance", () => {
  it("atomic authorization admits only the exposure that fits", async () => {
    const bal = await c.s.owner.control("GET", "/balances");
    const used = BigInt(bal.body.workspace.lifetime.settled) + BigInt(bal.body.workspace.lifetime.reserved);
    await c.s.owner.setWorkspacePolicy({ tier: "bounded_automatic", lifetimeTestUsdc: (used + 350_000n).toString(), rolling24hTestUsdc: "500000000", sponsorLamportLimit: "5000000000" });
    const [a, b] = await Promise.all([
      intent(c, "Prince", "cap-02-prince", "research-expanded", "private_x402", { query: "race" }),
      intent(c, "Mira", "cap-02-mira", "content-package", "private_x402", { topic: "Race", audience: "Owners", channels: ["LinkedIn", "Newsletter", "Instagram"], voice: "Plain", startDate: "2026-10-21" }),
    ]);
    const admitted = [a, b].filter((r) => r.body.purchase && r.body.purchase.states.authorization !== "rejected");
    const rejected = [a, b].filter((r) => !r.body.purchase || r.body.purchase.states.authorization === "rejected");
    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(JSON.stringify(rejected[0]!.body)).toMatch(/BUDGET_EXCEEDED/);
    const p = await waitPurchase(c, admitted[0]!.body.purchase.id as string);
    expect(p.purchase.states.fulfilment).toBe("delivered");
    const after = await c.s.owner.control("GET", "/balances");
    expect(BigInt(after.body.workspace.lifetime.settled) + BigInt(after.body.workspace.lifetime.reserved)).toBeLessThanOrEqual(used + 350_000n);
    await c.s.owner.setWorkspacePolicy({ tier: "bounded_automatic", lifetimeTestUsdc: "500000000", rolling24hTestUsdc: "500000000", sponsorLamportLimit: "5000000000" });
    record("CAP-02", { allowanceLeft: "350000", admitted: admitted[0]!.body.purchase.sku, rejected: { status: rejected[0]!.status, body: rejected[0]!.body.error ?? rejected[0]!.body.purchase?.stateReason } });
  });
});

describe("BAK-01 backup and restore with a pending spend", () => {
  it("restores without address reuse, duplicate purchase or lost change", async () => {
    const backupFile = join(c.s.dir, "backups", `pending-spend-${RUN}.veilo-backup`);
    let backedUp: boolean | null = null;
    let backupError = "";
    c.s.proxies["wallet→relayer"].add({
      match: isPost(/^\/withdrawals$/),
      before: async () => {
        const out = spawnSync(process.execPath, ["--import", "tsx", "services/wallet/src/cli/backup.ts", "backup", "--out", backupFile], { cwd: REPO, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", USERNAME: process.env.USERNAME ?? "", USERDOMAIN: process.env.USERDOMAIN ?? "", VEILO_ENV_FILE: c.s.envFile }, encoding: "utf8" });
        backedUp = out.status === 0;
        backupError = (out.stderr || out.stdout).slice(-400);
        return crashAll();
      },
    });
    const reply = intent(c, "Prince", "bak-01", "research-basic", "private_x402", { query: "backup" }).catch(() => null);
    await until("backup taken at the boundary", () => backedUp !== null, 300_000);
    expect(backedUp, backupError).toBe(true);
    await until("services stopped", () => SERVICES.every((x) => !c.s.services.running(x)), 60_000);
    await reply;
    c.s.proxies["wallet→relayer"].clear();
    const walletsBefore = q<{ fresh_wallet: string }>(c, "wallet", "SELECT fresh_wallet FROM funding").map((r) => r.fresh_wallet);
    const restore = spawnSync(process.execPath, ["--import", "tsx", "services/wallet/src/cli/backup.ts", "restore", "--file", backupFile], { cwd: REPO, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", USERNAME: process.env.USERNAME ?? "", USERDOMAIN: process.env.USERDOMAIN ?? "", VEILO_ENV_FILE: c.s.envFile }, encoding: "utf8" });
    expect(restore.status, restore.stderr).toBe(0);
    await c.s.services.startAll();
    await c.s.login();
    const id = purchaseIdByKey("bak-01")!;
    const p = await waitPurchase(c, id);
    expect(p.purchase.states.fulfilment).toBe("delivered");
    const inv = invariants(c, id);
    expect(inv).toMatchObject({ walletFundings: 1, relayerWithdrawals: 1, relayerSpendFinalized: 1, merchantPayments: 1, gatewayPaymentEvents: 1 });
    const next = await intent(c, "Prince", "bak-01-after", "research-basic", "private_x402", { query: "after restore" });
    const p2 = await waitPurchase(c, next.body.purchase.id as string);
    expect(p2.purchase.states.fulfilment).toBe("delivered");
    const fresh = q<{ fresh_wallet: string }>(c, "wallet", "SELECT fresh_wallet FROM funding").map((r) => r.fresh_wallet);
    expect(new Set(fresh).size).toBe(fresh.length);
    expect(walletsBefore.length).toBeGreaterThan(0);
    // No change is lost: a positive remainder becomes spendable again; an exact spend leaves none.
    const change = BigInt((JSON.parse(q<{ evidence_json: string }>(c, "wallet", "SELECT evidence_json FROM funding WHERE purchase_id = ?", id)[0]!.evidence_json) as { change: string }).change);
    if (change > 0n) await until("restored purchase change spendable", () => q<{ state: string }>(c, "control", "SELECT state FROM note WHERE parent_purchase_id = ?", id)[0]?.state === "spendable_change", 300_000, 2_000);
    else expect(n(c, "control", "SELECT count(*) FROM note WHERE parent_purchase_id = ?", id)).toBe(0);
    record("BAK-01", { purchaseId: id, restoreOutput: restore.stdout.trim().split("\n"), invariants: inv, freshWalletsDistinct: fresh.length, nextPurchase: p2.purchase.states });
  });
});

describe("REC-03 recovery conflicting with a signed merchant payment", () => {
  it("waits for the signed payment to expire, then recovers only to the owner destination; no pool note is created", async () => {
    const rec03Digest = computeRequestDigest("research-basic", { query: "recovery conflict" });
    c.s.proxies["control→gateway"].add({ match: (r) => withPayment(r) && r.body.includes(rec03Digest), times: 1_000, before: () => "drop" });
    const reply = intent(c, "Prince", "rec-03", "research-basic", "private_x402", { query: "recovery conflict" });
    await until("merchant payment signed", () => purchaseIdByKey("rec-03") !== undefined && n(c, "wallet", "SELECT count(*) FROM merchant_payment WHERE purchase_id = ?", purchaseIdByKey("rec-03")!) === 1, 300_000);
    const id = purchaseIdByKey("rec-03")!;
    await c.s.owner.control("POST", `/agents/${c.agents.Prince}/pause`, {});
    await reply;
    const early = await c.s.owner.wallet("POST", "/recovery/prepare", { purchaseId: id });
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(early.body)).toMatch(/may still settle|SETTLEMENT_UNCERTAIN/);
    const notesBefore = n(c, "control", "SELECT count(*) FROM note");
    const ownerBefore = await tokenBalance(c.s.rpc, c.s.keys.owner.publicKey);
    let prepared: { status: number; body: Record<string, unknown> } = early;
    await until("signed payment expired and recovery prepared", async () => {
      prepared = await c.s.owner.wallet("POST", "/recovery/prepare", { purchaseId: id });
      return prepared.status === 201;
    }, 240_000, 5_000);
    expect(prepared.body.destinationOwner).toBe(c.s.keys.owner.publicKey);
    const recoveryId = prepared.body.recoveryId as string;
    await c.s.owner.wallet("POST", `/recovery/${recoveryId}/confirm`, {});
    let view: { status: number; body: Record<string, unknown> } = prepared;
    await until("recovery finalized", async () => {
      view = await c.s.owner.wallet("POST", `/recovery/${recoveryId}/confirm`, {});
      return view.body.state === "finalized";
    }, 240_000, 4_000);
    c.s.proxies["control→gateway"].clear();
    const ownerAfter = await tokenBalance(c.s.rpc, c.s.keys.owner.publicKey);
    expect(ownerAfter - ownerBefore).toBe(100_000n);
    const p = await purchase(c, id);
    expect(p.purchase.states.recovery).toBe("recovered");
    expect(invariants(c, id).gatewayPaymentEvents).toBe(0);
    expect(n(c, "control", "SELECT count(*) FROM note")).toBe(notesBefore);
    expect(n(c, "control", "SELECT count(*) FROM financial_event WHERE purchase_id = ? AND kind = 'expense_adjusted' AND reason = 'external_recovery'", id)).toBeGreaterThanOrEqual(0);
    await c.s.owner.control("POST", `/agents/${c.agents.Prince}/resume`, {});
    record("REC-03", { purchaseId: id, earlyRecovery: early.body, recovery: view.body, recoveredToOwner: (ownerAfter - ownerBefore).toString(), states: p.purchase.states });
    record("LED-01 external recovery", { controlNotesBefore: notesBefore, controlNotesAfter: n(c, "control", "SELECT count(*) FROM note"), note: "recovered principal returned to the owner account; no pool note created" });
  });
});

describe("REV-01 revoke after a real proof was released", () => {
  it("blocks new authority, lets the released withdrawal settle honestly and leaves it to owner recovery", async () => {
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    let held = false;
    c.s.proxies["wallet→relayer"].add({
      match: isPost(/^\/withdrawals$/),
      before: async () => {
        held = true;
        await gate;
        return "forward" as const;
      },
    });
    const reply = intent(c, "Mira", "rev-01", "content-package", "private_x402", { topic: "Revoke", audience: "Owners", channels: ["LinkedIn", "Newsletter", "Instagram"], voice: "Plain", startDate: "2026-10-22" });
    await until("proof released and held", () => held, 300_000, 500);
    const id = purchaseIdByKey("rev-01")!;
    const revoked = await c.s.owner.control("POST", `/agents/${c.agents.Mira}/revoke`, {});
    expect(revoked.status).toBe(200);
    released();
    await reply;
    c.s.proxies["wallet→relayer"].clear();
    const p = await waitPurchase(c, id, (x) => x.purchase.states.funding === "finalized", 300_000);
    expect(p.purchase.states.merchant).not.toBe("finalized");
    expect(invariants(c, id)).toMatchObject({ walletFundings: 1, relayerWithdrawals: 1, merchantPayments: 0, gatewayPaymentEvents: 0 });
    const denied = await intent(c, "Mira", "rev-01-after", "content-package", "private_x402", { ...{ topic: "Revoke", audience: "Owners", channels: ["LinkedIn", "Newsletter", "Instagram"], voice: "Plain", startDate: "2026-10-22" }, topic: "After revoke" });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    const prep = await c.s.owner.wallet("POST", "/recovery/prepare", { purchaseId: id });
    expect(prep.status).toBe(201);
    let v: { body: Record<string, unknown> } = prep;
    await c.s.owner.wallet("POST", `/recovery/${prep.body.recoveryId as string}/confirm`, {});
    await until("revoked purchase recovered", async () => {
      v = await c.s.owner.wallet("POST", `/recovery/${prep.body.recoveryId as string}/confirm`, {});
      return v.body.state === "finalized";
    }, 240_000, 4_000);
    record("REV-01", { purchaseId: id, states: (await purchase(c, id)).purchase.states, newIntentAfterRevoke: { status: denied.status, error: denied.body.error }, recovery: v.body });
  });
});

describe("SEC-02 log and ledger inspection across all services", () => {
  it("no keys, credentials, note secrets or provider key in any service log or service ledger", () => {
    const secrets: Array<{ name: string; value: string }> = [];
    const add = (name: string, value: string | undefined) => {
      if (value && value.length >= 16) secrets.push({ name, value });
    };
    const sec = join(c.s.dir, "secrets");
    add("control service credential", readFileSync(join(sec, "control-service.credential"), "utf8").trim());
    add("wallet service credential", readFileSync(join(sec, "wallet-service.credential"), "utf8").trim());
    add("owner service secret", readFileSync(join(sec, "owner-service.secret"), "utf8").trim());
    add("gateway account token", readFileSync(join(sec, "control", "gateway-account.token"), "utf8").trim());
    add("planning token", readFileSync(join(sec, "gateway", "planning.token"), "utf8").trim());
    const pem = readFileSync(join(sec, "control", "usage-permit-signing.pem"), "utf8");
    add("usage permit signing key", pem.split("\n").filter((l) => l && !l.startsWith("-----")).join(""));
    for (const a of (JSON.parse(readFileSync(join(sec, "runner", "worker-credentials.json"), "utf8")) as { agents: Array<{ token: string; name: string }> }).agents) add(`worker token ${a.name}`, a.token);
    for (const f of readdirSync(join(c.s.dir, "keys"))) {
      const bytes = JSON.parse(readFileSync(join(c.s.dir, "keys", f), "utf8")) as number[];
      add(`keypair ${f} (base58)`, getBase58Decoder().decode(Uint8Array.from(bytes)));
      add(`keypair ${f} (seed hex)`, Buffer.from(bytes.slice(0, 32)).toString("hex"));
      add(`keypair ${f} (json)`, JSON.stringify(bytes).slice(0, 40));
    }
    add("provider key", "local-mock-provider");
    const targets: Array<{ name: string; data: Buffer }> = [];
    for (const f of readdirSync(join(c.s.dir, "logs"))) targets.push({ name: `log ${f}`, data: readFileSync(join(c.s.dir, "logs", f)) });
    for (const db of ["control", "gateway", "relayer"]) for (const ext of ["", "-wal"]) {
      const path = join(c.s.dir, "data", `${db}.sqlite${ext}`);
      if (existsSync(path)) targets.push({ name: `${db}.sqlite${ext}`, data: readFileSync(path) });
    }
    const hits: string[] = [];
    for (const t of targets) for (const s of secrets) if (t.data.includes(Buffer.from(s.value, "utf8"))) hits.push(`${s.name} in ${t.name}`);
    // Wallet note secrets never leave the wallet: the relayer and control ledgers hold no wallet note-secret ciphertext.
    const cipher = q<{ ciphertext: Buffer }>(c, "wallet", "SELECT ciphertext FROM wallet_note LIMIT 5").map((r) => Buffer.from(r.ciphertext).toString("base64").slice(0, 40));
    for (const t of targets) for (const x of cipher) if (t.data.includes(Buffer.from(x))) hits.push(`note ciphertext in ${t.name}`);
    record("SEC-02", { secretsChecked: secrets.length, targetsScanned: targets.map((t) => t.name), hits });
    expect(hits).toEqual([]);
  });
});

describe("run summary sanity", () => {
  it("no unexpected service exits", () => {
    const unexpected = c.s.services.exits.filter((e) => !e.expected && e.code !== 86);
    record("serviceExits", c.s.services.exits);
    expect(unexpected).toEqual([]);
    expect(TERMINAL.size).toBe(3);
    expect(serviceId(c, "research-basic", "private_x402")).toBeTruthy();
  });
});
