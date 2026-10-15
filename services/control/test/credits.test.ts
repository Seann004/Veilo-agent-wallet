import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_CREDIT_LABEL, computeRequestDigest } from "@veilo/contracts/gateway";
import { runCreditCheck } from "../src/agents/shawn";
import { makeStack, type Stack } from "./fixtures/stack";

let s: Stack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const MIN = 60_000;
const issuances = (st: Stack) => st.gwCount("SELECT count(*) FROM credit_issuances");
const shawnCheck = (st: Stack, ownerRetry = false) =>
  runCreditCheck({ ledger: st.env.ledger, gateway: st.gatewayClient, orchestrator: st.integration.orchestrator }, st.env.agents.Shawn.id, { ownerRetry });

/** Consumes credits through Prince's prepaid path so Shawn sees a low balance again. */
async function drain(st: Stack, key: string, sku: "analyze" | "summarize" = "analyze") {
  const input = { text: `Repair cafe notes ${key}`, ...(sku === "analyze" ? { question: "What matters?" } : {}) };
  const r = await st.call("/purchase-intents", {
    method: "POST",
    headers: { authorization: `Bearer ${st.worker("Prince")}` },
    body: { idempotencyKey: key, serviceId: serviceId(st, sku, "prepaid_credits"), sku, paymentPath: "prepaid_credits", requestDigest: computeRequestDigest(sku, input), input },
  });
  return r;
}

function serviceId(st: Stack, sku: string, path: string): string {
  return st.env.db
    .prepare(`SELECT s.service_id FROM service_sku s JOIN approved_service a ON a.id = s.service_id WHERE a.workspace_id = ? AND s.sku = ? AND s.payment_path = ?`)
    .pluck()
    .get(st.env.ws.id, sku, path) as string;
}

describe("CRE-03 Shawn low-credit replenishment", () => {
  it("repeated checks, scheduler ticks and a restart produce one episode and one issuance", async () => {
    s = await makeStack();
    const first = await shawnCheck(s);
    expect(first.decision).toBe("top_up_completed");
    expect(first.sequence).toBe(1);
    expect(issuances(s)).toBe(1);
    expect(s.testFunding.calls).toMatchObject({ prepare: 1, release: 1, sign: 1 });

    // Balance is now 1,000,000: repeated checks find it sufficient.
    for (let i = 0; i < 3; i += 1) expect((await shawnCheck(s)).decision).toBe("sufficient");
    await s.integration.scheduler.tick();
    await s.integration.scheduler.tick();
    await s.restart();
    await s.integration.scheduler.tick();
    expect(issuances(s)).toBe(1);
    expect(s.count("SELECT count(*) FROM credit_episode")).toBe(1);
    expect(s.count("SELECT count(*) FROM purchase WHERE sku = 'inference-credit-pack'")).toBe(1);
    expect(s.count("SELECT sequence FROM credit_replenishment")).toBe(1);
    // Exactly one re-evaluation was scheduled for the completed episode, and it did not loop.
    expect(s.count("SELECT count(*) FROM job WHERE trigger_key LIKE 'reeval:%'")).toBe(1);
  });

  it("enforces cooldown, then caps; a rejected episode pauses until owner retry", async () => {
    s = await makeStack({ agents: { Shawn: { rolling24hTestUsdc: "2000000", lifetimeTestUsdc: "2000000" } } });
    expect((await shawnCheck(s)).decision).toBe("top_up_completed");
    // Drain below the 200,000 threshold: 1,000,000 - 5 x 200,000 = 0.
    for (let i = 0; i < 5; i += 1) expect((await drain(s, `d${i}`)).body.purchase.states.fulfilment).toBe("delivered");
    expect((await shawnCheck(s)).decision).toBe("cooldown");
    s.gw.clock.advance(11 * MIN);
    expect((await shawnCheck(s)).decision).toBe("top_up_completed");
    expect(issuances(s)).toBe(2);
    for (let i = 5; i < 10; i += 1) await drain(s, `d${i}`);
    s.gw.clock.advance(11 * MIN);
    // Agent rolling cap 2,000,000 is used: the third pack is denied by the independent policy check.
    const denied = await shawnCheck(s);
    expect(denied.decision).toBe("rejected");
    expect(denied.detail).toMatch(/rolling 24-hour cap|lifetime/);
    expect((await shawnCheck(s)).decision).toBe("paused_after_rejection");
    expect((await shawnCheck(s)).decision).toBe("paused_after_rejection");
    expect(s.count("SELECT count(*) FROM credit_episode")).toBe(3);
    // Owner retry runs the same logic; the cap still holds, so it is rejected again.
    expect((await shawnCheck(s, true)).decision).toBe("rejected");
    expect(issuances(s)).toBe(2);
  });

  it("stale or unavailable balance pauses the check without a purchase", async () => {
    s = await makeStack();
    s.faults.push({ match: /credits\/balance/, when: "before", remaining: 1 });
    expect((await shawnCheck(s)).decision).toBe("paused_balance_unavailable");
    s.env.ledger.now = () => s!.gw.clock.t + 10 * MIN;
    expect((await shawnCheck(s)).decision).toBe("paused_stale_balance");
    expect(s.count("SELECT count(*) FROM purchase")).toBe(0);
  });

  it("without a wallet service the top-up stays one outstanding, unreleased operation (NOT_READY)", async () => {
    s = await makeStack({ funding: "unavailable" });
    const r = await shawnCheck(s);
    expect(r.decision).toBe("top_up_started");
    for (let i = 0; i < 3; i += 1) expect((await shawnCheck(s)).decision).toBe("outstanding_top_up");
    await s.integration.scheduler.tick();
    expect(s.count("SELECT count(*) FROM purchase")).toBe(1);
    const p = s.env.db.prepare("SELECT * FROM purchase").get() as { id: string; authorization_state: string; funding_state: string };
    // Authority to prepare was recorded, but nothing was prepared or released.
    expect(p).toMatchObject({ authorization_state: "reserved", funding_state: "proof_prepared" });
    expect(s.count("SELECT funding_ref IS NULL FROM purchase_execution WHERE purchase_id = ?", p.id)).toBe(1);
    expect(s.integration.orchestrator.view(p.id).blocked).toMatchObject({ code: "NOT_READY" });
    expect(s.gwCount("SELECT count(*) FROM payment_attempts")).toBe(0);
    expect(issuances(s)).toBe(0);
  });
});

describe("scheduler", () => {
  it("coalesces downtime into one observation and dedupes ticks within a slot", async () => {
    s = await makeStack();
    expect(s.integration.scheduler.enqueueDueChecks()).toHaveLength(1);
    expect(s.integration.scheduler.enqueueDueChecks()).toHaveLength(0);
    await s.integration.scheduler.runCreditJobs();
    s.gw.clock.advance(3 * 3_600_000);
    // Three hours of missed 60-second polls produce one new job, not 180.
    expect(s.integration.scheduler.enqueueDueChecks()).toHaveLength(1);
    expect(s.integration.scheduler.enqueueDueChecks()).toHaveLength(0);
    const ran = await s.integration.scheduler.runCreditJobs();
    expect(ran).toHaveLength(1);
    expect(s.count("SELECT count(*) FROM job WHERE kind = 'credit_check' AND trigger_key LIKE 'poll:%'")).toBe(2);
  });

  it("Check now over HTTP runs the same deterministic check", async () => {
    s = await makeStack();
    const owner = await s.login();
    const r = await s.call(`/agents/${s.env.agents.Shawn.id}/run`, { method: "POST", headers: s.ownerHeaders(owner), body: {} });
    expect(r.status).toBe(202);
    expect(r.body.check.decision).toBe("top_up_completed");
    expect(r.body.job.state).toBe("completed");
    const again = await s.call(`/agents/${s.env.agents.Shawn.id}/run`, { method: "POST", headers: s.ownerHeaders(owner), body: {} });
    expect(again.body.check.decision).toBe("sufficient");
    expect(issuances(s)).toBe(1);
  });
});

describe("CRE-05 balances never double count", () => {
  it("reports cash spent once, credits purchased/consumed/reserved and sponsored planning separately", async () => {
    s = await makeStack();
    await shawnCheck(s);
    await drain(s, "c1");
    const owner = await s.login();
    const b = await s.call("/balances", { headers: { cookie: owner.cookie } });
    expect(b.status).toBe(200);
    expect(b.body.cash).toMatchObject({ unit: "usdc_base_units", spent: "1000000", reserved: "0" });
    expect(b.body.gatewayCredits).toMatchObject({
      available: true,
      label: GATEWAY_CREDIT_LABEL,
      purchased: "1000000",
      consumed: "200000",
      reserved: "0",
      usable: "800000",
      stale: false,
    });
    const prince = b.body.usageByAgent.find((u: { name: string }) => u.name === "Prince");
    const shawn = b.body.usageByAgent.find((u: { name: string }) => u.name === "Shawn");
    expect(prince).toMatchObject({ consumedUnits: "200000", packsPurchased: 0 });
    expect(shawn).toMatchObject({ packsPurchased: 1, packCashSpent: "1000000", consumedUnits: "0" });
    expect(b.body.cash.byAgent.find((a: { name: string }) => a.name === "Prince").spent).toBe("0");
    expect(b.body.sponsoredPlanning).toMatchObject({ label: "operator-sponsored planning", total: 0 });
    // The consumption never appears as USDC expenditure.
    expect(s.count("SELECT ifnull(sum(amount), 0) FROM financial_event WHERE kind = 'expense_settled' AND asset = 'usdc'")).toBe(1_000_000);
  });
});
