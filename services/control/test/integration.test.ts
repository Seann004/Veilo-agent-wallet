import { afterEach, describe, expect, it } from "vitest";
import { computeRequestDigest } from "@veilo/contracts/gateway";
import { saveArtifact } from "../src/ledger/summaries";
import { makeStack, type Stack } from "./fixtures/stack";

let s: Stack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const MIN = 60_000;

function serviceId(st: Stack, sku: string, path: string): string {
  return st.env.db
    .prepare(`SELECT s.service_id FROM service_sku s JOIN approved_service a ON a.id = s.service_id WHERE a.workspace_id = ? AND s.sku = ? AND s.payment_path = ?`)
    .pluck()
    .get(st.env.ws.id, sku, path) as string;
}

async function intent(st: Stack, agent: "Prince" | "Mira" | "Shawn", key: string, sku: string, path: "private_x402" | "prepaid_credits", input: Record<string, unknown>, taskId?: string) {
  return st.call("/purchase-intents", {
    method: "POST",
    headers: { authorization: `Bearer ${st.worker(agent)}` },
    body: { idempotencyKey: key, serviceId: serviceId(st, sku, path), sku, paymentPath: path, requestDigest: computeRequestDigest(sku, input), input, ...(taskId ? { taskId } : {}) },
  });
}

async function fundCredits(st: Stack) {
  const r = await intent(st, "Shawn", "pack-1", "inference-credit-pack", "private_x402", { packs: 1 });
  expect(r.body.purchase.states).toMatchObject({ funding: "finalized", merchant: "finalized", fulfilment: "delivered" });
  return r;
}

describe("direct x402 purchase through funding provider and gateway", () => {
  it("settles once, records both legs and the attempt signatures; repeats return the same operation", async () => {
    s = await makeStack();
    const r = await fundCredits(s);
    expect(r.status).toBe(201);
    expect(r.body.purchase.label).toBe("Delivered");
    expect(r.body.execution.result).toMatchObject({ kind: "credit_pack", issuedUnits: "1000000" });
    const legs = r.body.purchase.chainAttempts.map((a: { leg: string; commitment: string }) => `${a.leg}:${a.commitment}`).sort();
    expect(legs).toEqual(["funding:finalized", "merchant:finalized"]);
    const again = await intent(s, "Shawn", "pack-1", "inference-credit-pack", "private_x402", { packs: 1 });
    expect(again.status).toBe(200);
    expect(again.body.purchase.id).toBe(r.body.purchase.id);
    expect(s.gw.facilitator.settleCalls).toBe(1);
    expect(s.testFunding.calls).toMatchObject({ prepare: 1, release: 1, sign: 1 });
    // The input note was consumed once and its remainder is pending change, not spendable.
    expect(s.count("SELECT count(*) FROM note WHERE state = 'pending_change' AND value = 4000000")).toBe(1);
  });

  it("QUO-02: an expired quote before merchant signing is re-quoted and existing funding is reused", async () => {
    s = await makeStack();
    s.testFunding.behavior = "submitted_then_finalize";
    const r = await intent(s, "Prince", "data-1", "research-basic", "private_x402", { query: "repair cafes" });
    expect(r.body.purchase.states.funding).toBe("submitted");
    expect(r.body.execution.blocked.code).toBe("SETTLEMENT_UNCERTAIN");
    s.gw.clock.advance(11 * MIN);
    s.testFunding.settle(r.body.purchase.id);
    const owner = await s.login();
    const rec = await s.call(`/purchases/${r.body.purchase.id}/reconcile`, { method: "POST", headers: s.ownerHeaders(owner), body: {} });
    expect(rec.body.purchase.states).toMatchObject({ funding: "finalized", merchant: "finalized", fulfilment: "delivered" });
    expect(rec.body.execution.quotes).toHaveLength(2);
    expect(rec.body.execution.result.records.length).toBeGreaterThan(0);
    expect(s.testFunding.calls).toMatchObject({ prepare: 1, release: 1, sign: 1 });
    expect(s.gw.facilitator.settleCalls).toBe(1);
  });

  it("rejects a quote whose recipient differs from the approved binding before releasing anything", async () => {
    s = await makeStack();
    s.env.db.prepare(`UPDATE approved_service SET recipient_ata = 'So11111111111111111111111111111111111111112'`).run();
    const r = await intent(s, "Prince", "data-x", "research-basic", "private_x402", { query: "q" });
    expect(r.body.purchase.states).toMatchObject({ authorization: "rejected", funding: "abandoned" });
    expect(r.body.execution.blocked.code).toBe("SERVICE_NOT_ALLOWED");
    expect(s.testFunding.calls.prepare).toBe(0);
  });
});

describe("T12 merchant signing failures", () => {
  it("a pre-sign wallet failure is retried on the same funding: one withdrawal, one signature, delivered", async () => {
    s = await makeStack({ settleWaitMs: 10_000, settlePollMs: 1 });
    s.testFunding.signFaults = ["pre_sign_not_ready", "pre_sign_not_ready"];
    const r = await intent(s, "Prince", "t12-pre", "research-basic", "private_x402", { query: "repair cafes" });
    expect(r.body.purchase.states).toMatchObject({ funding: "finalized", merchant: "finalized", fulfilment: "delivered", recovery: "none" });
    expect(r.body.execution.blocked).toBeNull();
    expect(s.testFunding.calls).toMatchObject({ prepare: 1, release: 1, sign: 1, signAttempts: 3 });
    expect(s.gw.facilitator.settleCalls).toBe(1);
    const legs = r.body.purchase.chainAttempts.map((a: { leg: string }) => a.leg).sort();
    expect(legs).toEqual(["funding", "merchant"]);
  });

  it("without a wait budget the pre-sign failure stays NOT_READY and the sweep completes the same purchase", async () => {
    s = await makeStack({ purchaseSweepMs: 0 });
    const owner = await s.login();
    await s.call(`/agents/${s.env.agents.Shawn.id}/pause`, { method: "POST", headers: s.ownerHeaders(owner), body: {} });
    s.testFunding.signFaults = ["pre_sign_not_ready"];
    const r = await intent(s, "Prince", "t12-sweep", "research-basic", "private_x402", { query: "sweep" });
    expect(r.body.purchase.states).toMatchObject({ funding: "finalized", merchant: "signed", recovery: "none" });
    expect(r.body.execution.blocked.code).toBe("NOT_READY");
    await s.integration.scheduler.tick();
    const after = await s.call(`/purchases/${r.body.purchase.id}`, { headers: { authorization: `Bearer ${s.worker("Prince")}` } });
    expect(after.body.purchase.states).toMatchObject({ funding: "finalized", merchant: "finalized", fulfilment: "delivered" });
    expect(s.testFunding.calls).toMatchObject({ prepare: 1, release: 1, sign: 1, signAttempts: 2 });
    expect(s.gw.facilitator.settleCalls).toBe(1);
  });

  it("a failure after the fresh wallet signed stays with reconciliation and is never re-signed", async () => {
    s = await makeStack({ settleWaitMs: 10_000, settlePollMs: 1, purchaseSweepMs: 0 });
    const owner = await s.login();
    await s.call(`/agents/${s.env.agents.Shawn.id}/pause`, { method: "POST", headers: s.ownerHeaders(owner), body: {} });
    s.testFunding.signFaults = ["post_sign_lost"];
    const r = await intent(s, "Prince", "t12-post", "research-basic", "private_x402", { query: "lost" });
    expect(r.body.purchase.states).toMatchObject({ funding: "finalized", merchant: "signed" });
    expect(r.body.execution.blocked.code).toBe("RECOVERY_REQUIRED");
    // Neither the request's wait, an owner reconcile nor the sweep signs a second payment.
    expect(s.testFunding.calls.signAttempts).toBe(1);
    await s.call(`/purchases/${r.body.purchase.id}/reconcile`, { method: "POST", headers: s.ownerHeaders(owner), body: {} });
    await s.integration.scheduler.tick();
    expect(s.testFunding.calls).toMatchObject({ prepare: 1, release: 1, sign: 1 });
    expect(s.gw.facilitator.settleCalls).toBe(0);
    const after = await s.call(`/purchases/${r.body.purchase.id}`, { headers: { authorization: `Bearer ${s.worker("Prince")}` } });
    expect(after.body.purchase.states.merchant).toBe("signed");
    expect(after.body.execution.blocked.code).toBe("RECOVERY_REQUIRED");
  });
});

describe("background reconciliation of pending purchases", () => {
  it("the scheduler sweep completes a purchase whose withdrawal finalized after the request returned", async () => {
    s = await makeStack({ purchaseSweepMs: 0 });
    // A scheduled credit check would start its own purchase on the same tick.
    const owner = await s.login();
    await s.call(`/agents/${s.env.agents.Shawn.id}/pause`, { method: "POST", headers: s.ownerHeaders(owner), body: {} });
    s.testFunding.behavior = "submitted_then_finalize";
    const r = await intent(s, "Prince", "sweep-1", "research-basic", "private_x402", { query: "sweep" });
    expect(r.body.purchase.states.funding).toBe("submitted");
    await s.integration.scheduler.tick();
    expect((await s.call(`/purchases/${r.body.purchase.id}`, { headers: { authorization: `Bearer ${s.worker("Prince")}` } })).body.purchase.states.funding).toBe("submitted");
    s.testFunding.settle(r.body.purchase.id);
    await s.integration.scheduler.tick();
    const after = await s.call(`/purchases/${r.body.purchase.id}`, { headers: { authorization: `Bearer ${s.worker("Prince")}` } });
    expect(after.body.purchase.states).toMatchObject({ funding: "finalized", merchant: "finalized", fulfilment: "delivered" });
    expect(s.testFunding.calls).toMatchObject({ prepare: 1, release: 1, sign: 1 });
    expect(s.gw.facilitator.settleCalls).toBe(1);
  });
});

describe("REC-01 release recorded but never delivered to the wallet", () => {
  it("re-sends the same release while authority is current, and refuses after a pause", async () => {
    s = await makeStack();
    const realRelease = s.testFunding.release.bind(s.testFunding);
    let lost = 0;
    // What the live provider reports when the wallet never received the request.
    s.testFunding.release = async () => {
      lost += 1;
      return { status: "recovery_required", reason: "wallet service unreachable: TypeError" };
    };
    const r = await intent(s, "Prince", "lost-release", "research-basic", "private_x402", { query: "lost release" });
    expect(r.body.purchase.states.funding).toBe("proof_released");
    expect(lost).toBe(1);
    s.testFunding.release = realRelease;
    const owner = await s.login();
    const rec = await s.call(`/purchases/${r.body.purchase.id}/reconcile`, { method: "POST", headers: s.ownerHeaders(owner), body: {} });
    expect(rec.body.purchase.states).toMatchObject({ funding: "finalized", merchant: "finalized", fulfilment: "delivered" });
    expect(s.testFunding.calls).toMatchObject({ prepare: 1, release: 1, sign: 1 });

    s.testFunding.release = async () => ({ status: "recovery_required", reason: "wallet service unreachable: TypeError" });
    const r2 = await intent(s, "Prince", "lost-release-2", "research-basic", "private_x402", { query: "lost release 2" });
    s.testFunding.release = realRelease;
    await s.call(`/agents/${s.env.agents.Prince.id}/pause`, { method: "POST", headers: s.ownerHeaders(owner), body: {} });
    const rec2 = await s.call(`/purchases/${r2.body.purchase.id}/reconcile`, { method: "POST", headers: s.ownerHeaders(owner), body: {} });
    expect(rec2.body.purchase.states.funding).toBe("proof_released");
    expect(rec2.body.execution.blocked.code).toBe("RECOVERY_REQUIRED");
    expect(s.testFunding.calls.release).toBe(1);
  });
});

describe("USG-01 failure between scoped and account reservations", () => {
  it("a lost authorize reply is reconciled with the same permit: one reservation, one debit", async () => {
    s = await makeStack();
    await fundCredits(s);
    s.faults.push({ match: /usage\/authorize/, when: "after", remaining: 1 });
    const input = { text: "Repair cafes fixed 418 items.", question: "What is notable?" };
    const r = await intent(s, "Prince", "use-1", "analyze", "prepaid_credits", input);
    expect(r.body.purchase.states.authorization).toBe("released");
    expect(r.body.execution.blocked.code).toBe("NOT_READY");
    // The gateway did reserve; control does not know the reservation ID yet.
    expect(s.gwCount("SELECT count(*) FROM credit_events WHERE kind = 'reserve'")).toBe(1);
    await s.restart();
    const status = await s.call(`/purchases/${r.body.purchase.id}`, { headers: { authorization: `Bearer ${s.worker("Prince")}` } });
    expect(status.body.purchase.states.fulfilment).toBe("delivered");
    expect(s.gwCount("SELECT count(*) FROM credit_events WHERE kind = 'reserve'")).toBe(1);
    expect(s.gwCount("SELECT count(*) FROM credit_events WHERE kind = 'consume'")).toBe(1);
    expect(s.gwCount("SELECT count(*) FROM usage_operations")).toBe(1);
    expect(s.count("SELECT count(*) FROM financial_event WHERE kind = 'expense_settled' AND asset = 'usage_units'")).toBe(1);
    expect(s.provider.calls.filter((c) => c.messages[0]?.content.startsWith("Analyze")).length).toBe(1);
    // Repeating the logical request returns the same delivered operation.
    const again = await intent(s, "Prince", "use-1", "analyze", "prepaid_credits", input);
    expect(again.body.purchase.id).toBe(r.body.purchase.id);
    expect(s.gwCount("SELECT count(*) FROM credit_events WHERE kind = 'consume'")).toBe(1);
  });

  it("a permit that never reached the gateway is released only after expiry proves no reservation", async () => {
    s = await makeStack();
    await fundCredits(s);
    s.faults.push({ match: /usage\/authorize/, when: "before", remaining: 5 });
    const input = { text: "notes" };
    const r = await intent(s, "Prince", "use-2", "summarize", "prepaid_credits", input);
    expect(r.body.purchase.reservation.status).toBe("active");
    s.gw.clock.advance(4 * MIN);
    const owner = await s.login();
    const rec = await s.call(`/purchases/${r.body.purchase.id}/reconcile`, { method: "POST", headers: s.ownerHeaders(owner), body: {} });
    expect(rec.body.purchase.states.fulfilment).toBe("abandoned");
    expect(rec.body.purchase.reservation).toMatchObject({ status: "released", closeReason: "pre_dispatch_failure" });
    expect(s.gwCount("SELECT count(*) FROM usage_operations")).toBe(0);
    expect(s.gwCount("SELECT count(*) FROM credit_events WHERE kind = 'reserve'")).toBe(0);
  });

  it("an ambiguous provider outcome keeps units and allowance reserved; no second inference", async () => {
    s = await makeStack();
    await fundCredits(s);
    s.provider.responder = () => ({ kind: "ambiguous" });
    const r = await intent(s, "Prince", "use-3", "summarize", "prepaid_credits", { text: "t" });
    expect(r.body.purchase.states.fulfilment).toBe("uncertain");
    expect(r.body.purchase.label).toBe("Waiting for confirmation");
    expect(r.body.purchase.reservation.status).toBe("active");
    const calls = s.provider.calls.length;
    await s.restart();
    expect(s.provider.calls.length).toBe(calls);
    expect(s.gwCount("SELECT reserved FROM accounts")).toBe(100_000);
  });
});

describe("lease expiry moves a job to reconciliation, not re-execution", () => {
  it("reconciles the job's existing operation and marks the task incomplete", async () => {
    s = await makeStack();
    await fundCredits(s);
    const owner = await s.login();
    const run = await s.call(`/agents/${s.env.agents.Prince.id}/run`, { method: "POST", headers: s.ownerHeaders(owner), body: { objective: "Why do repair cafes work?" } });
    const W = { authorization: `Bearer ${s.worker("Prince")}` };
    const claim = await s.call("/worker/jobs/claim", { method: "POST", headers: W, body: { workerId: "runner-a", leaseMs: 60_000 } });
    expect(claim.body.job.state).toBe("leased");
    s.faults.push({ match: /usage\/execute/, when: "before", remaining: 1 });
    const r = await intent(s, "Prince", "lease-1", "summarize", "prepaid_credits", { text: "x" }, run.body.taskId);
    expect(r.body.execution.blocked.code).toBe("NOT_READY");
    s.gw.clock.advance(61_000);
    const moved = await s.integration.scheduler.reconcileExpired();
    expect(moved).toEqual([claim.body.job.id]);
    const job = s.env.db.prepare("SELECT state, result_json FROM job WHERE id = ?").get(claim.body.job.id) as { state: string; result_json: string };
    expect(job.state).toBe("failed");
    expect(JSON.parse(job.result_json)).toMatchObject({ reconciled: true, purchases: [r.body.purchase.id] });
    expect(s.count("SELECT state = 'incomplete' FROM task WHERE id = ?", run.body.taskId)).toBe(1);
    expect(s.count("SELECT count(*) FROM purchase WHERE task_id = ?", run.body.taskId)).toBe(1);
    expect(s.count("SELECT fulfilment_state = 'delivered' FROM purchase WHERE id = ?", r.body.purchase.id)).toBe(1);
    // The stale worker cannot complete the job afterwards.
    const late = await s.call(`/worker/jobs/${claim.body.job.id}/complete`, { method: "POST", headers: W, body: { workerId: "runner-a", version: claim.body.job.version, outcome: "completed" } });
    expect(late.status).toBe(409);
  });
});

describe("CNT-02 owner edits, approval and calendar changes", () => {
  it("never trigger inference, purchases, gateway calls or publishing", async () => {
    s = await makeStack();
    const owner = await s.login();
    const run = await s.call(`/agents/${s.env.agents.Mira.id}/run`, {
      method: "POST",
      headers: s.ownerHeaders(owner),
      body: { input: { topic: "Repair cafes", audience: "Neighbours", channels: ["LinkedIn", "Newsletter", "Instagram"], voice: "Warm", startDate: "2026-10-20" } },
    });
    expect(run.status).toBe(202);
    const mira = s.env.agents.Mira;
    const draft = saveArtifact(s.env.ledger, mira, { taskId: run.body.taskId, kind: "content_draft", title: "LinkedIn", content: "Body", citations: [], sourcePurchaseIds: [] });
    const calendar = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, date: `2026-10-${19 + day}`, channel: "LinkedIn", draftArtifactId: day === 1 ? draft.id : null, action: "plan" }));
    const cal = saveArtifact(s.env.ledger, mira, { taskId: run.body.taskId, kind: "content_calendar", title: "Calendar", content: JSON.stringify(calendar), citations: [], sourcePurchaseIds: [] });

    const snapshot = () => ({
      purchases: s!.count("SELECT count(*) FROM purchase"),
      financial: s!.count("SELECT count(*) FROM financial_event"),
      outbox: s!.count("SELECT count(*) FROM outbox"),
      jobs: s!.count("SELECT count(*) FROM job"),
      providerCalls: s!.provider.calls.length,
      gatewayQuotes: s!.gwCount("SELECT count(*) FROM quotes"),
      gatewayUsage: s!.gwCount("SELECT count(*) FROM usage_operations"),
      planning: s!.gwCount("SELECT count(*) FROM planning_calls"),
    });
    const before = snapshot();
    const H = s.ownerHeaders(owner);
    const edit = await s.call(`/content/${draft.id}`, { method: "PATCH", headers: H, body: { content: "Edited body", title: "LinkedIn v2" } });
    expect(edit.body.item).toMatchObject({ revision: 2, lastAuthor: "owner", content: "Edited body" });
    expect((await s.call(`/content/${draft.id}/review`, { method: "POST", headers: H, body: { state: "needs_review" } })).body.item.reviewState).toBe("needs_review");
    expect((await s.call(`/content/${draft.id}/review`, { method: "POST", headers: H, body: { state: "approved_for_export" } })).body.item.reviewState).toBe("approved_for_export");
    const moved = calendar.map((e) => (e.day === 2 ? { ...e, action: "moved by owner", date: "2026-10-25" } : e));
    const calEdit = await s.call(`/content/${cal.id}`, { method: "PATCH", headers: H, body: { calendar: moved } });
    expect(calEdit.status).toBe(200);
    const view = await s.call("/calendar", { headers: { cookie: owner.cookie } });
    expect(view.body.calendars[0].entries).toHaveLength(7);
    expect(view.body.calendars[0].entries[1].action).toBe("moved by owner");
    expect(view.body.calendars[0].entries[0].draft).toMatchObject({ reviewState: "approved_for_export" });
    // Editing approved content returns it to review; archiving blocks edits.
    const reEdit = await s.call(`/content/${draft.id}`, { method: "PATCH", headers: H, body: { content: "Again" } });
    expect(reEdit.body.item.reviewState).toBe("needs_review");
    await s.call(`/content/${draft.id}/review`, { method: "POST", headers: H, body: { state: "archived" } });
    expect((await s.call(`/content/${draft.id}`, { method: "PATCH", headers: H, body: { content: "x" } })).status).toBe(403);
    const list = await s.call("/content?kind=content_draft", { headers: { cookie: owner.cookie } });
    expect(list.body.items[0].publishing).toMatch(/no publishing/);
    expect(snapshot()).toEqual(before);
    // Agents cannot approve or edit owner-approved content, and have no content endpoints.
    const W = { authorization: `Bearer ${s.worker("Mira")}` };
    expect((await s.call(`/content/${cal.id}/review`, { method: "POST", headers: W, body: { state: "approved_for_export" } })).status).toBe(403);
    expect((await s.call(`/content/${cal.id}`, { method: "PATCH", headers: W, body: { content: "x" } })).status).toBe(403);
  });
});
