import { computeRequestDigest } from "@veilo/contracts/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { verifyCounters } from "../src/ledger/credits";
import { buildPaymentHeader, makeHarness, VALID_CONTENT, type Harness } from "./harness";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const count = (sql: string, ...args: unknown[]) => Number((h.db.prepare(sql).get(...args) as { n: bigint }).n);

/** Funds an account with one credit pack through the x402 path. */
async function fundedAccount() {
  const acct = h.account();
  const q = await h.quote(acct.token, "inference-credit-pack", { packs: 1 });
  const quote = { quoteId: q.body.quoteId, operationId: q.operationId, requestDigest: q.requestDigest };
  const c = await h.challenge(acct.token, quote);
  const paid = await h.pay(acct.token, quote, (await buildPaymentHeader(c.paymentRequired!)).header);
  expect(paid.body.state).toBe("delivered");
  return acct;
}

function usageRequest(accountId: string, sku: "summarize" | "analyze" | "content-package", input: unknown, operationId: string) {
  const units = { summarize: "100000", analyze: "200000", "content-package": "300000" }[sku];
  return { accountId, sku, units, requestDigest: computeRequestDigest(sku, input), operationId };
}

describe("prepaid usage permits", () => {
  it("reserves, executes and consumes once; replays return the same reservation and result (CRE-04)", async () => {
    h = await makeHarness();
    const { token, accountId } = await fundedAccount();
    const input = { text: "Repair cafes fixed 418 items." };
    const permit = h.permit(usageRequest(accountId, "summarize", input, "use-1"));
    const auth = await h.call("POST", "/usage/authorize", token, { permit });
    expect(auth.status).toBe(201);
    expect(auth.body).toMatchObject({ state: "reserved", units: "100000", balance: { reserved: "100000", usable: "900000" } });
    const replay = await h.call("POST", "/usage/authorize", token, { permit });
    expect(replay.status).toBe(200);
    expect(replay.body.reservationId).toBe(auth.body.reservationId);

    const exec = await h.call("POST", "/usage/execute", token, { operationId: "use-1", reservationId: auth.body.reservationId, input });
    expect(exec.status).toBe(200);
    expect(exec.body).toMatchObject({ state: "completed", onChainCharge: "none", balance: { consumed: "100000", reserved: "0", usable: "900000" } });
    const again = await h.call("POST", "/usage/execute", token, { operationId: "use-1", reservationId: auth.body.reservationId, input });
    expect(again.body.result).toEqual(exec.body.result);
    expect(h.provider!.calls).toHaveLength(1);
    expect(count("SELECT COUNT(*) AS n FROM credit_events WHERE kind = 'consume'")).toBe(1);

    const status = await h.call("GET", "/usage/use-1", token);
    expect(status.body.state).toBe("completed");
    verifyCounters(h.db, accountId);
  });

  it("CRE-04: a modified input digest is rejected with no debit and no inference", async () => {
    h = await makeHarness();
    const { token, accountId } = await fundedAccount();
    const input = { text: "original" };
    const auth = await h.call("POST", "/usage/authorize", token, { permit: h.permit(usageRequest(accountId, "summarize", input, "use-2")) });
    const tampered = await h.call("POST", "/usage/execute", token, { operationId: "use-2", reservationId: auth.body.reservationId, input: { text: "changed" } });
    expect(tampered.status).toBe(409);
    expect(h.provider!.calls).toHaveLength(0);
    expect(count("SELECT COUNT(*) AS n FROM credit_events WHERE kind = 'consume'")).toBe(0);
  });

  it("rejects permits that are forged, expired, for another account, or with the wrong units; nonce reuse on another operation conflicts", async () => {
    h = await makeHarness();
    const { token, accountId } = await fundedAccount();
    const other = h.account();
    const req = usageRequest(accountId, "summarize", { text: "a" }, "use-3");
    const permit = h.permit(req);
    const parts = permit.split(".");
    const forged = `${parts[0]}.${parts[1]}.${Buffer.alloc(64, 1).toString("base64url")}`;
    expect((await h.call("POST", "/usage/authorize", token, { permit: forged })).status).toBe(401);
    expect((await h.call("POST", "/usage/authorize", other.token, { permit })).status).toBe(403);
    const expired = h.permit(req);
    h.clock.advance(5 * 60_000);
    expect((await h.call("POST", "/usage/authorize", token, { permit: expired })).body.error.message).toContain("expired");
    expect((await h.call("POST", "/usage/authorize", token, { permit: h.permit({ ...req, units: "1" }) })).status).toBe(409);
    const ok = await h.call("POST", "/usage/authorize", token, { permit: h.permit({ ...req, nonce: "nonce-fixed" }) });
    expect(ok.status).toBe(201);
    const reuse = await h.call("POST", "/usage/authorize", token, {
      permit: h.permit({ ...usageRequest(accountId, "summarize", { text: "b" }, "use-4"), nonce: "nonce-fixed" }),
    });
    expect(reuse.status).toBe(409);
  });

  it("CRE-02: concurrent usage over available credits admits a bounded number and never goes negative", async () => {
    h = await makeHarness();
    const { token, accountId } = await fundedAccount();
    const permits = [1, 2, 3, 4, 5].map((i) =>
      h.permit(usageRequest(accountId, "content-package", { topic: `t${i}`, audience: "a", channels: ["A", "B", "C"], voice: "v" }, `cp-${i}`)),
    );
    const results = await Promise.all(permits.map((permit) => h.call("POST", "/usage/authorize", token, { permit })));
    const admitted = results.filter((r) => r.status === 201);
    const denied = results.filter((r) => r.status === 409);
    expect(admitted).toHaveLength(3);
    expect(denied).toHaveLength(2);
    expect(denied[0]!.body.error.code).toBe("BUDGET_EXCEEDED");
    const bal = (await h.call("GET", "/credits/balance", token)).body;
    expect(bal).toMatchObject({ issued: "1000000", reserved: "900000", usable: "100000" });
    verifyCounters(h.db, accountId);
  });

  it("USG-01: a retried authorization reuses the reservation; pre-dispatch failure releases once; ambiguous dispatch keeps the reservation", async () => {
    h = await makeHarness();
    const { token, accountId } = await fundedAccount();
    const input = { text: "x" };
    const req = usageRequest(accountId, "summarize", input, "use-5");
    const first = await h.call("POST", "/usage/authorize", token, { permit: h.permit(req) });
    const retried = await h.call("POST", "/usage/authorize", token, { permit: h.permit(req) });
    expect(retried.body.reservationId).toBe(first.body.reservationId);
    expect(count("SELECT COUNT(*) AS n FROM credit_events WHERE kind = 'reserve'")).toBe(1);
    const rel1 = await h.call("POST", "/usage/use-5/release", token, { reservationId: first.body.reservationId });
    const rel2 = await h.call("POST", "/usage/use-5/release", token, { reservationId: first.body.reservationId });
    expect([rel1.status, rel2.status]).toEqual([200, 200]);
    expect(count("SELECT COUNT(*) AS n FROM credit_events WHERE kind = 'release'")).toBe(1);

    const long = { text: "y".repeat(8_200) };
    const a2 = await h.call("POST", "/usage/authorize", token, { permit: h.permit(usageRequest(accountId, "summarize", long, "use-6")) });
    const e2 = await h.call("POST", "/usage/execute", token, { operationId: "use-6", reservationId: a2.body.reservationId, input: long });
    expect(e2.status).toBe(413);
    expect(e2.body.state).toBe("released");

    h.provider!.behavior = { kind: "ambiguous" };
    const a3 = await h.call("POST", "/usage/authorize", token, { permit: h.permit(usageRequest(accountId, "summarize", input, "use-7")) });
    const e3 = await h.call("POST", "/usage/execute", token, { operationId: "use-7", reservationId: a3.body.reservationId, input });
    expect(e3.body.state).toBe("uncertain");
    expect(e3.body.balance.reserved).toBe("100000");
    expect((await h.call("POST", "/usage/use-7/release", token, { reservationId: a3.body.reservationId })).status).toBe(409);
    await h.call("POST", "/usage/execute", token, { operationId: "use-7", reservationId: a3.body.reservationId, input });
    await h.gateway.recover();
    expect(h.provider!.calls).toHaveLength(1);
    verifyCounters(h.db, accountId);
  });

  it("CRE-05: pack purchase and later consumption are separate records; USDC is spent once", async () => {
    h = await makeHarness();
    const { token, accountId } = await fundedAccount();
    h.provider!.behavior = { kind: "text", text: VALID_CONTENT };
    const input = { topic: "t", audience: "a", channels: ["LinkedIn", "Newsletter", "Instagram"], voice: "v" };
    const a = await h.call("POST", "/usage/authorize", token, { permit: h.permit(usageRequest(accountId, "content-package", input, "cp")) });
    const e = await h.call("POST", "/usage/execute", token, { operationId: "cp", reservationId: a.body.reservationId, input });
    expect(e.body).toMatchObject({ state: "completed", paymentPath: "prepaid", onChainCharge: "none" });
    expect(count("SELECT COUNT(*) AS n FROM payment_events")).toBe(1);
    expect(count("SELECT COALESCE(SUM(amount), 0) AS n FROM payment_events")).toBe(1_000_000);
    expect((await h.call("GET", "/credits/balance", token)).body).toMatchObject({ issued: "1000000", consumed: "300000", usable: "700000" });
  });

  it("credit events are append-only", async () => {
    h = await makeHarness();
    await fundedAccount();
    expect(() => h.db.prepare("UPDATE credit_events SET units = 1").run()).toThrow(/append-only/);
    expect(() => h.db.prepare("DELETE FROM credit_events").run()).toThrow(/append-only/);
  });
});

describe("LLM-01 provider bounds", () => {
  async function authorized(input = { text: "hello" }, op = `u-${Math.random().toString(36).slice(2)}`) {
    const { token, accountId } = await fundedAccount();
    const a = await h.call("POST", "/usage/authorize", token, { permit: h.permit(usageRequest(accountId, "summarize", input, op)) });
    return { token, accountId, op, input, reservationId: a.body.reservationId as string, auth: a };
  }

  it("timeout is uncertain, retained and never retried", async () => {
    h = await makeHarness();
    h.provider!.behavior = { kind: "ambiguous" };
    const u = await authorized();
    const r = await h.call("POST", "/usage/execute", u.token, { operationId: u.op, reservationId: u.reservationId, input: u.input });
    expect(r.body.state).toBe("uncertain");
    const ledger = h.db.prepare("SELECT state FROM operator_cost_ledger").get() as { state: string };
    expect(ledger.state).toBe("uncertain");
    expect(h.provider!.calls).toHaveLength(1);
  });

  it("exhausted provider account (HTTP 402) fails closed and releases the reservation", async () => {
    h = await makeHarness();
    h.provider!.behavior = { kind: "definite", status: 402 };
    const u = await authorized();
    const r = await h.call("POST", "/usage/execute", u.token, { operationId: u.op, reservationId: u.reservationId, input: u.input });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ state: "released", balance: { reserved: "0", consumed: "0" } });
    expect((h.db.prepare("SELECT state FROM operator_cost_ledger").get() as { state: string }).state).toBe("released");
    expect(h.provider!.calls).toHaveLength(1);
  });

  it("a live price above the pinned tariff disables dispatch", async () => {
    h = await makeHarness({ prices: { prompt: "0.000001", completion: "0.000001" } });
    const { token, accountId } = await fundedAccount().catch(() => ({ token: "", accountId: "" }));
    void accountId;
    expect(h.gateway.health().provider.inference).toMatchObject({ ready: false, code: "PRICE_CHANGED" });
    const q = await h.quote(token || h.account().token, "summarize", { text: "x" });
    expect(q.status).toBe(503);
    expect(h.provider!.calls).toHaveLength(0);
  });

  it("stale or unavailable pricing fails closed", async () => {
    h = await makeHarness();
    h.clock.advance(2 * 3600_000);
    expect(h.gateway.health().provider.inference).toMatchObject({ ready: false, code: "PROVIDER_UNAVAILABLE" });
    await h.close();
    h = await makeHarness({ prices: "down" });
    expect(h.gateway.health().provider.inference.ready).toBe(false);
  });

  it("stops before dispatch when the operator dollar ceiling would be exceeded", async () => {
    h = await makeHarness({ ceilingMicro: 100n });
    const u = await authorized();
    const r = await h.call("POST", "/usage/execute", u.token, { operationId: u.op, reservationId: u.reservationId, input: u.input });
    expect(r.body).toMatchObject({ state: "released", error: { code: "OPERATOR_BUDGET_EXHAUSTED" } });
    expect(h.provider!.calls).toHaveLength(0);
  });

  it("reserves worst-case cost at the pinned tariff and records the reported actual cost", async () => {
    h = await makeHarness();
    const u = await authorized();
    await h.call("POST", "/usage/execute", u.token, { operationId: u.op, reservationId: u.reservationId, input: u.input });
    const row = h.db.prepare("SELECT worst_case_micro, actual_micro, actual_source, state FROM operator_cost_ledger").get() as Record<string, unknown>;
    // 8,000 input tokens * 29,000 pico + 1,000 output tokens * 30,000 pico = 262 micro-USD.
    expect(row).toMatchObject({ worst_case_micro: 262n, actual_micro: 3n, actual_source: "provider_reported", state: "settled" });
    expect(h.provider!.calls[0]!.maxPrice).toEqual({ prompt: 0.029, completion: 0.03 });
    expect(h.provider!.calls[0]!.maxOutputTokens).toBe(1000);
  });
});

describe("sponsored planning", () => {
  it("allows at most two planning calls per task with a separate credential", async () => {
    h = await makeHarness();
    const body = { taskRef: "task-1", purpose: "choose dataset", messages: [{ role: "user", content: "plan" }] };
    const auth = { authorization: "Bearer planning-token-for-tests-0001" };
    expect((await h.call("POST", "/planning/complete", undefined, body)).status).toBe(401);
    const one = await h.call("POST", "/planning/complete", undefined, body, auth);
    const two = await h.call("POST", "/planning/complete", undefined, body, auth);
    const three = await h.call("POST", "/planning/complete", undefined, body, auth);
    expect([one.status, two.status, three.status]).toEqual([200, 200, 429]);
    expect(one.body).toMatchObject({ label: "operator-sponsored planning", callIndex: 1, remainingCalls: 1 });
    expect(h.provider!.calls).toHaveLength(2);
    expect(Number((h.db.prepare("SELECT COUNT(*) AS n FROM operator_cost_ledger WHERE purpose = 'planning'").get() as { n: bigint }).n)).toBe(2);
  });
});
