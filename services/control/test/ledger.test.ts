import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "@veilo/contracts";
import { DAY_MS, type Ledger } from "../src/context";
import { ControlError } from "../src/errors";
import { authorizePurchase, type AuthorizeInput } from "../src/ledger/authorize";
import { emergencyStop, pauseAgent } from "../src/ledger/authority";
import { lifetimeUsage, rollingUsage } from "../src/ledger/accounting";
import { claimNextJob, completeJob, enqueueJob, expireLeases, heartbeatJob } from "../src/ledger/jobs";
import { confirmChangeInserted, tokenBuckets } from "../src/ledger/notes";
import {
  advanceAuthority,
  decidePurchase,
  getPurchaseRow,
  markRecoverable,
  markUncertain,
  recordExternalRecovery,
  recordFundingExpiredUnsettled,
  recordFundingFinalized,
  recordMerchantFinalized,
  recordMerchantRefund,
  recordUsageConsumed,
} from "../src/ledger/purchases";
import { agentBudget, createTask } from "../src/ledger/summaries";
import { activatePolicyVersion, insertAgentPolicyDraft, requireAgent } from "../src/ledger/workspace";
import { immediate } from "@veilo/db";
import { T0, activateDefaults, addNotes, addService, createEnv, digest, type TestEnv } from "./helpers";

let env: TestEnv;
afterEach(() => env?.cleanup());

type Name = "Shawn" | "Prince" | "Mira";

function authorize(e: TestEnv, name: Name, key: string, serviceId: string, extra: Partial<AuthorizeInput> = {}) {
  return authorizePurchase(e.ledger, {
    workspaceId: e.ws.id,
    agentId: e.agents[name].id,
    idempotencyKey: key,
    serviceId,
    sku: "research-basic",
    paymentPath: "private_x402",
    requestDigest: digest(key),
    ...extra,
  });
}

function expectDenied(fn: () => unknown, code: string, message?: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).code).toBe(code);
    if (message) expect((error as ControlError).message).toMatch(message);
    return;
  }
  throw new Error(`expected ${code}`);
}

const count = (l: Ledger, sql: string, ...args: unknown[]) => Number(l.db.prepare(sql).pluck().get(...args));

/** Drives a private purchase to a finalized merchant settlement. */
function settle(e: TestEnv, purchaseId: string, change: bigint, settledAtMs: number, fees = 0n, commitment?: string) {
  const p = getPurchaseRow(e.ledger, purchaseId);
  advanceAuthority(e.ledger, purchaseId, "prepare_proof");
  advanceAuthority(e.ledger, purchaseId, "release_proof");
  recordFundingFinalized(e.ledger, purchaseId, {
    payout: p.price_usdc,
    tokenFees: fees,
    change,
    changeCommitment: change > 0n ? (commitment ?? purchaseId.replace(/-/g, "").padEnd(64, "a")) : null,
    observedAtMs: settledAtMs,
  });
  advanceAuthority(e.ledger, purchaseId, "sign_merchant");
  return recordMerchantFinalized(e.ledger, purchaseId, { merchantAmount: p.price_usdc, tokenFees: fees, sponsorLamports: 0n, settledAtMs });
}

describe("seeded defaults", () => {
  it("seeds draft policies that cannot spend until the owner activates them", () => {
    env = createEnv();
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [1_000_000n]);
    expectDenied(() => authorize(env, "Prince", "k1", svc), "POLICY_DENIED", /workspace policy has not been activated/);
    activatePolicyVersion(env.ledger, env.ws.id, null, 1, { type: "owner", id: "o" });
    expectDenied(() => authorize(env, "Prince", "k1", svc), "ACCOUNT_STOPPED", /agent is draft/);
    expect(count(env.ledger, "SELECT count(*) FROM purchase")).toBe(0);
  });

  it("re-running the seed changes nothing", async () => {
    env = createEnv();
    const { seedWorkspace } = await import("../src/ledger/workspace");
    const before = count(env.ledger, "SELECT count(*) FROM policy");
    const r = seedWorkspace(env.ledger, { ownerPubkey: env.owner.address, network: env.ws.network, mint: env.ws.mint, mintDecimals: 6 });
    expect(r.created).toBe(false);
    expect(count(env.ledger, "SELECT count(*) FROM policy")).toBe(before);
    expect(count(env.ledger, "SELECT count(*) FROM agent")).toBe(3);
    expect(count(env.ledger, "SELECT count(*) FROM approved_service WHERE status = 'unbound'")).toBe(2);
  });
});

describe("CAP-01 per-purchase, task, agent and workspace caps", () => {
  it("rejects a purchase above the per-purchase hard limit without creating exposure", () => {
    env = createEnv();
    activateDefaults(env);
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 490_000n, fee: 20_000n }]);
    addNotes(env, [1_000_000n]);
    expectDenied(() => authorize(env, "Prince", "k1", svc), "BUDGET_EXCEEDED", /per-purchase/);
    expect(count(env.ledger, "SELECT count(*) FROM purchase")).toBe(0);
    expect(count(env.ledger, "SELECT count(*) FROM reservation")).toBe(0);
    expect(count(env.ledger, "SELECT count(*) FROM note WHERE state = 'approved'")).toBe(1);
    expect(count(env.ledger, "SELECT count(*) FROM audit_event WHERE policy_result = 'denied'")).toBe(1);
  });

  it("enforces the per-task lifetime budget and paid-purchase count", () => {
    env = createEnv();
    activateDefaults(env);
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 200_000n }]);
    addNotes(env, [1_000_000n, 1_000_000n, 1_000_000n]);
    const task = createTask(env.ledger, { workspaceId: env.ws.id, agent: env.agents.Prince, objective: "q", input: {}, limitUsdc: "350000" });
    authorize(env, "Prince", "t1", svc, { taskId: task.id });
    expectDenied(() => authorize(env, "Prince", "t2", svc, { taskId: task.id }), "BUDGET_EXCEEDED", /task budget/);
    const t2 = createTask(env.ledger, { workspaceId: env.ws.id, agent: env.agents.Prince, objective: "q2", input: {}, limitUsdc: "5000000" });
    env.ledger.db.prepare("UPDATE task SET max_purchases = 1 WHERE id = ?").run(t2.id);
    authorize(env, "Prince", "t3", svc, { taskId: t2.id });
    expectDenied(() => authorize(env, "Prince", "t4", svc, { taskId: t2.id }), "BUDGET_EXCEEDED", /purchase count/);
  });

  it("rejects a task belonging to another agent", () => {
    env = createEnv();
    activateDefaults(env);
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 200_000n }]);
    addNotes(env, [1_000_000n]);
    const mirasTask = createTask(env.ledger, { workspaceId: env.ws.id, agent: env.agents.Mira, objective: "q", input: {} });
    expectDenied(() => authorize(env, "Prince", "x", svc, { taskId: mirasTask.id }), "POLICY_DENIED", /task scope mismatch/);
  });

  it("enforces agent lifetime and workspace lifetime allocations", () => {
    env = createEnv();
    activateDefaults(env, { workspace: { lifetimeTestUsdc: "600000" }, agents: { Prince: { lifetimeTestUsdc: "400000" } } });
    const svc = addService(env, [
      { sku: "research-basic", paymentPath: "private_x402", price: 200_000n },
      { sku: "analyze", paymentPath: "private_x402", price: 200_000n },
    ]);
    addNotes(env, [1_000_000n, 1_000_000n, 1_000_000n, 1_000_000n]);
    authorize(env, "Prince", "a1", svc);
    authorize(env, "Prince", "a2", svc);
    expectDenied(() => authorize(env, "Prince", "a3", svc), "BUDGET_EXCEEDED", /agent lifetime/);
    authorize(env, "Mira", "m1", svc, { sku: "analyze" });
    expectDenied(() => authorize(env, "Mira", "m2", svc, { sku: "analyze" }), "BUDGET_EXCEEDED", /workspace lifetime/);
  });

  it("enforces agent and workspace rolling caps independently of lifetime", () => {
    env = createEnv();
    activateDefaults(env, {
      workspace: { rolling24hTestUsdc: "500000" },
      agents: { Prince: { rolling24hTestUsdc: "300000" } },
    });
    const svc = addService(env, [
      { sku: "research-basic", paymentPath: "private_x402", price: 200_000n },
      { sku: "analyze", paymentPath: "private_x402", price: 200_000n },
    ]);
    addNotes(env, [1_000_000n, 1_000_000n, 1_000_000n, 1_000_000n]);
    authorize(env, "Prince", "a1", svc);
    expectDenied(() => authorize(env, "Prince", "a2", svc), "BUDGET_EXCEEDED", /agent rolling/);
    authorize(env, "Mira", "m1", svc, { sku: "analyze" });
    expectDenied(() => authorize(env, "Mira", "m2", svc, { sku: "analyze" }), "BUDGET_EXCEEDED", /workspace rolling/);
  });

  it("reserves sponsor lamports against their own allowance, separate from USDC", () => {
    env = createEnv();
    activateDefaults(env, { workspace: { sponsorLamportLimit: "3000000" } });
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n, lamports: 2_100_000n }]);
    addNotes(env, [1_000_000n, 1_000_000n]);
    authorize(env, "Prince", "s1", svc);
    expectDenied(() => authorize(env, "Prince", "s2", svc), "BUDGET_EXCEEDED", /sponsor lamport/);
    const u = lifetimeUsage(env.ledger, { kind: "workspace", id: env.ws.id }, "usdc", 10_000_000n);
    expect(u.reserved).toBe(100_000n);
  });

  it("enforces gateway usage caps for prepaid SKUs without touching USDC allowance", () => {
    env = createEnv();
    activateDefaults(env, { agents: { Prince: { usageAllowanceUnits: "500000", taskCreditUnits: "400000" } } });
    const svc = addService(env, [{ sku: "summarize", paymentPath: "prepaid_credits", units: 300_000n }]);
    const task = createTask(env.ledger, { workspaceId: env.ws.id, agent: env.agents.Prince, objective: "q", input: {} });
    const p = authorize(env, "Prince", "u1", svc, { sku: "summarize", paymentPath: "prepaid_credits", taskId: task.id });
    expect(p.purchase.funding_state).toBe("not_required");
    expectDenied(
      () => authorize(env, "Prince", "u2", svc, { sku: "summarize", paymentPath: "prepaid_credits", taskId: task.id }),
      "BUDGET_EXCEEDED",
      /task usage cap/,
    );
    expectDenied(() => authorize(env, "Prince", "u3", svc, { sku: "summarize", paymentPath: "prepaid_credits" }), "BUDGET_EXCEEDED", /agent usage allowance/);
    advanceAuthority(env.ledger, p.purchase.id, "issue_usage_permit");
    recordUsageConsumed(env.ledger, p.purchase.id, 300_000n, T0);
    const agent = { kind: "agent", id: env.agents.Prince.id } as const;
    expect(lifetimeUsage(env.ledger, agent, "usdc", 2_000_000n).settled).toBe(0n);
    expect(lifetimeUsage(env.ledger, agent, "usage_units", 500_000n).settled).toBe(300_000n);
  });

  it("rejects unapproved services, disallowed SKUs and wrong network/mint bindings", () => {
    env = createEnv();
    activateDefaults(env);
    addNotes(env, [1_000_000n]);
    const seeded = env.ledger.db.prepare("SELECT id FROM approved_service WHERE service_key = 'veilo-research-data'").pluck().get() as string;
    expectDenied(() => authorize(env, "Prince", "x1", seeded), "SERVICE_NOT_ALLOWED", /not approved/);
    const svc = addService(env, [{ sku: "content-package", paymentPath: "private_x402", price: 100_000n }]);
    expectDenied(() => authorize(env, "Prince", "x2", svc, { sku: "content-package" }), "SERVICE_NOT_ALLOWED", /does not permit/);
    const other = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n }]);
    env.ledger.db.prepare("UPDATE approved_service SET network = 'solana:other' WHERE id = ?").run(other);
    expectDenied(() => authorize(env, "Prince", "x3", other), "WRONG_NETWORK");
    env.ledger.db.prepare("UPDATE approved_service SET network = ?, mint = 'OtherMint' WHERE id = ?").run(env.ws.network, other);
    expectDenied(() => authorize(env, "Prince", "x4", other), "WRONG_MINT");
  });
});

describe("policy tiers", () => {
  it("observe plans only, stopped reconciles only, approval_required waits for the owner", () => {
    env = createEnv();
    activateDefaults(env, { agents: { Prince: { tier: "observe" }, Mira: { tier: "approval_required", approvalThresholdTestUsdc: "150000" } } });
    const svc = addService(env, [
      { sku: "research-basic", paymentPath: "private_x402", price: 100_000n },
      { sku: "analyze", paymentPath: "private_x402", price: 200_000n },
      { sku: "summarize", paymentPath: "private_x402", price: 100_000n },
    ]);
    addNotes(env, [1_000_000n, 1_000_000n, 1_000_000n]);
    expectDenied(() => authorize(env, "Prince", "o1", svc), "POLICY_DENIED", /observe/);

    const small = authorize(env, "Mira", "m-small", svc, { sku: "summarize" });
    expect(small.purchase.authorization_state).toBe("reserved");
    const big = authorize(env, "Mira", "m-big", svc, { sku: "analyze" });
    expect(big.purchase.authorization_state).toBe("awaiting_approval");
    expectDenied(() => advanceAuthority(env.ledger, big.purchase.id, "prepare_proof"), "IDEMPOTENCY_CONFLICT");
    expect(decidePurchase(env.ledger, big.purchase.id, "approve", "owner").authorization_state).toBe("reserved");

    const rejected = authorize(env, "Mira", "m-big-2", svc, { sku: "analyze" });
    const after = decidePurchase(env.ledger, rejected.purchase.id, "reject", "owner");
    expect(after.authorization_state).toBe("rejected");
    expect(count(env.ledger, "SELECT count(*) FROM reservation WHERE purchase_id = ? AND status = 'released'", after.id)).toBe(1);

    const draft = immediate(env.ledger.db, () =>
      insertAgentPolicyDraft(env.ledger, env.ws.id, env.agents.Mira.id, { ...defaultsFor("Mira"), tier: "stopped" }, "owner"),
    );
    activatePolicyVersion(env.ledger, env.ws.id, env.agents.Mira.id, Number(draft.version), { type: "owner", id: "o" });
    expectDenied(() => authorize(env, "Mira", "m-stopped", svc, { sku: "summarize" }), "ACCOUNT_STOPPED");
  });

  it("no tier overrides hard caps", () => {
    env = createEnv();
    activateDefaults(env, { agents: { Mira: { tier: "approval_required", maxPurchaseTestUsdc: "100000" } } });
    const svc = addService(env, [{ sku: "analyze", paymentPath: "private_x402", price: 200_000n }]);
    addNotes(env, [1_000_000n]);
    expectDenied(() => authorize(env, "Mira", "big", svc, { sku: "analyze" }), "BUDGET_EXCEEDED", /per-purchase/);
  });
});

describe("policy expiry after authorization", () => {
  const expiresAt = new Date(T0 + 60_000).toISOString();

  it("approval after the agent policy expires is denied and frees the reservation", () => {
    env = createEnv();
    activateDefaults(env, { agents: { Mira: { tier: "approval_required", approvalThresholdTestUsdc: "50000", expiresAt } } });
    const svc = addService(env, [{ sku: "analyze", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [1_000_000n]);
    const p = authorize(env, "Mira", "late", svc, { sku: "analyze" }).purchase;
    expect(p.authorization_state).toBe("awaiting_approval");

    env.clock.t = T0 + 60_000;
    expectDenied(() => decidePurchase(env.ledger, p.id, "approve", "owner"), "POLICY_DENIED", /agent policy expired/);
    expect(getPurchaseRow(env.ledger, p.id)).toMatchObject({ authorization_state: "rejected", funding_state: "abandoned" });
    expect(count(env.ledger, "SELECT count(*) FROM reservation WHERE purchase_id = ? AND status = 'released'", p.id)).toBe(1);
    expect(count(env.ledger, "SELECT count(*) FROM note WHERE state = 'approved'")).toBe(1);
  });

  it("proof release after the workspace policy expires is denied", () => {
    env = createEnv();
    activateDefaults(env, { workspace: { expiresAt } });
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [1_000_000n]);
    const p = authorize(env, "Prince", "prep", svc).purchase;
    advanceAuthority(env.ledger, p.id, "prepare_proof");

    env.clock.t = T0 + 60_001;
    expectDenied(() => advanceAuthority(env.ledger, p.id, "release_proof"), "POLICY_DENIED", /workspace policy expired/);
    expect(getPurchaseRow(env.ledger, p.id)).toMatchObject({ authorization_state: "rejected", funding_state: "abandoned" });
  });

  it("approval before expiry still proceeds", () => {
    env = createEnv();
    activateDefaults(env, { agents: { Mira: { tier: "approval_required", approvalThresholdTestUsdc: "50000", expiresAt } } });
    const svc = addService(env, [{ sku: "analyze", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [1_000_000n]);
    const p = authorize(env, "Mira", "early", svc, { sku: "analyze" }).purchase;
    env.clock.t = T0 + 59_999;
    expect(decidePurchase(env.ledger, p.id, "approve", "owner").authorization_state).toBe("reserved");
  });
});

const defaultsFor = (name: Name) => DEFAULT_AGENTS.find((a) => a.name === name)!.policy;

describe("CAP-03 uncertain payment crossing the rolling window", () => {
  it("keeps counting a live reservation after 24 hours", () => {
    env = createEnv();
    activateDefaults(env, { agents: { Prince: { rolling24hTestUsdc: "1000000", lifetimeTestUsdc: "5000000", maxPurchaseTestUsdc: "1000000" } } });
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 600_000n }]);
    addNotes(env, [1_000_000n, 1_000_000n]);
    const a = authorize(env, "Prince", "A", svc).purchase;
    advanceAuthority(env.ledger, a.id, "prepare_proof");
    advanceAuthority(env.ledger, a.id, "release_proof");
    advanceAuthority(env.ledger, a.id, "submit_withdrawal");
    markUncertain(env.ledger, a.id, "funding");

    env.clock.t = T0 + DAY_MS + 3_600_000;
    const agent = { kind: "agent", id: env.agents.Prince.id } as const;
    expect(rollingUsage(env.ledger, agent, "usdc", 1_000_000n, env.clock.t).reserved).toBe(600_000n);
    expectDenied(() => authorize(env, "Prince", "B", svc), "BUDGET_EXCEEDED", /rolling/);

    // Uncertain cannot be collapsed into failure; only proven-unsettled evidence releases it.
    expect(() => env.ledger.db.prepare("UPDATE purchase SET funding_state = 'abandoned' WHERE id = ?").run(a.id)).toThrow(/invalid funding state transition/);
    recordFundingExpiredUnsettled(env.ledger, a.id);
    expect(authorize(env, "Prince", "B", svc).created).toBe(true);
  });

  it("lets settled cost age out of the window while lifetime still counts it", () => {
    env = createEnv();
    activateDefaults(env, { agents: { Prince: { rolling24hTestUsdc: "1000000", lifetimeTestUsdc: "5000000", maxPurchaseTestUsdc: "1000000" } } });
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 600_000n }]);
    addNotes(env, [600_000n, 600_000n]);
    const a = authorize(env, "Prince", "A", svc).purchase;
    settle(env, a.id, 0n, T0);
    expectDenied(() => authorize(env, "Prince", "B", svc), "BUDGET_EXCEEDED", /rolling/);
    env.clock.t = T0 + DAY_MS + 1;
    expect(authorize(env, "Prince", "B", svc).created).toBe(true);
    const agent = { kind: "agent", id: env.agents.Prince.id } as const;
    expect(lifetimeUsage(env.ledger, agent, "usdc", 5_000_000n).settled).toBe(600_000n);
  });

  it("sets the settled timestamp once and never rewrites it", () => {
    env = createEnv();
    activateDefaults(env);
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [100_000n]);
    const a = authorize(env, "Prince", "A", svc).purchase;
    settle(env, a.id, 0n, T0 + 5_000);
    env.clock.t = T0 + 99_000;
    const again = recordMerchantFinalized(env.ledger, a.id, { merchantAmount: 100_000n, tokenFees: 0n, sponsorLamports: 0n, settledAtMs: T0 + 99_000 });
    expect(Number(again.settled_at_ms)).toBe(T0 + 5_000);
    expect(() => env.ledger.db.prepare("UPDATE purchase SET settled_at_ms = ? WHERE id = ?").run(T0 + 1, a.id)).toThrow(/immutable/);
    expect(count(env.ledger, "SELECT count(*) FROM financial_event WHERE kind = 'expense_settled' AND purchase_id = ?", a.id)).toBe(1);
  });
});

describe("CAP-04 lowering a limit below pending exposure", () => {
  it("blocks new spend and keeps the exposure visible", () => {
    env = createEnv();
    activateDefaults(env);
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 500_000n }]);
    addNotes(env, [500_000n, 500_000n, 500_000n, 500_000n]);
    for (const k of ["a", "b", "c"]) authorize(env, "Prince", k, svc);
    const draft = immediate(env.ledger.db, () =>
      insertAgentPolicyDraft(env.ledger, env.ws.id, env.agents.Prince.id, { ...defaultsFor("Prince"), lifetimeTestUsdc: "1000000" }, "owner"),
    );
    activatePolicyVersion(env.ledger, env.ws.id, env.agents.Prince.id, Number(draft.version), { type: "owner", id: "o" });
    expectDenied(() => authorize(env, "Prince", "d", svc), "BUDGET_EXCEEDED", /agent lifetime/);
    const budget = agentBudget(env.ledger, requireAgent(env.ledger, env.ws.id, env.agents.Prince.id)) as {
      policyVersion: number;
      lifetime: Record<string, string>;
    };
    expect(budget.policyVersion).toBe(2);
    expect(budget.lifetime).toMatchObject({ limit: "1000000", reserved: "1500000", available: "0", overCommitted: "500000" });
    expect(count(env.ledger, "SELECT count(*) FROM reservation WHERE status = 'active'")).toBe(3);
    // Earlier purchases keep the policy version they were authorized under.
    expect(count(env.ledger, "SELECT count(*) FROM purchase WHERE agent_policy_version = 1")).toBe(3);
  });
});

describe("IDEM-01 same logical purchase repeated", () => {
  it("returns one operation with one reservation and the same state", () => {
    env = createEnv();
    activateDefaults(env);
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 500_000n }]);
    addNotes(env, [500_000n, 500_000n, 500_000n, 500_000n, 500_000n]);
    const first = authorize(env, "Prince", "episode-1", svc);
    const again = authorize(env, "Prince", "episode-1", svc);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.purchase.id).toBe(first.purchase.id);
    expect(again.purchase.operation_id).toBe(first.purchase.operation_id);
    advanceAuthority(env.ledger, first.purchase.id, "prepare_proof");
    // Exhaust the allowance; the repeated request still returns the existing operation.
    for (const k of ["x", "y", "z"]) authorize(env, "Prince", k, svc);
    const third = authorize(env, "Prince", "episode-1", svc);
    expect(third.purchase.funding_state).toBe("proof_prepared");
    expect(count(env.ledger, "SELECT count(*) FROM purchase WHERE idempotency_key = 'episode-1'")).toBe(1);
    expect(count(env.ledger, "SELECT count(*) FROM reservation WHERE purchase_id = ?", first.purchase.id)).toBe(1);
    expect(count(env.ledger, "SELECT count(*) FROM financial_event WHERE kind = 'reservation_opened' AND purchase_id = ?", first.purchase.id)).toBe(1);
    expect(count(env.ledger, "SELECT count(*) FROM note WHERE reserved_purchase_id = ?", first.purchase.id)).toBe(1);
    expectDenied(
      () => authorize(env, "Prince", "episode-1", svc, { requestDigest: digest("changed") }),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("keeps operation IDs unique per workspace at the database level", () => {
    env = createEnv();
    activateDefaults(env);
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [100_000n, 100_000n]);
    const a = authorize(env, "Prince", "a", svc).purchase;
    const b = authorize(env, "Prince", "b", svc).purchase;
    expect(() => env.ledger.db.prepare("UPDATE purchase SET operation_id = ? WHERE id = ?").run(a.operation_id, b.id)).toThrow();
  });
});

describe("LED-01 physical token states", () => {
  it("keeps pending change unavailable and external recovery out of the pool", () => {
    env = createEnv();
    activateDefaults(env);
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 300_000n, fee: 10_000n, lamports: 2_100_000n }]);
    addNotes(env, [1_000_000n]);
    const ws = env.ws.id;

    const p1 = authorize(env, "Prince", "p1", svc).purchase;
    expect(tokenBuckets(env.ledger, ws)).toMatchObject({ approved_unreserved: 0n, reserved_input: 1_000_000n });
    advanceAuthority(env.ledger, p1.id, "prepare_proof");
    advanceAuthority(env.ledger, p1.id, "release_proof");
    expect(() =>
      recordFundingFinalized(env.ledger, p1.id, { payout: 300_000n, tokenFees: 10_000n, change: 600_000n, changeCommitment: "c".repeat(64), observedAtMs: T0 }),
    ).toThrow(/conserve/);
    recordFundingFinalized(env.ledger, p1.id, { payout: 300_000n, tokenFees: 10_000n, change: 690_000n, changeCommitment: "c".repeat(64), observedAtMs: T0 });
    expect(tokenBuckets(env.ledger, ws)).toMatchObject({
      reserved_input: 0n,
      consumed: 1_000_000n,
      payout_balance: 300_000n,
      fee_outflow: 10_000n,
      pending_change: 690_000n,
      confirmed_change: 0n,
    });

    expectDenied(() => authorize(env, "Prince", "p2", svc), "NOTE_PENDING");
    expect(count(env.ledger, "SELECT count(*) FROM purchase WHERE idempotency_key = 'p2'")).toBe(0);
    confirmChangeInserted(env.ledger, p1.id);
    expect(tokenBuckets(env.ledger, ws)).toMatchObject({ pending_change: 0n, confirmed_change: 690_000n });

    advanceAuthority(env.ledger, p1.id, "sign_merchant");
    recordMerchantFinalized(env.ledger, p1.id, { merchantAmount: 300_000n, tokenFees: 10_000n, sponsorLamports: 2_000_000n, settledAtMs: T0 });

    const p2 = authorize(env, "Prince", "p2", svc).purchase;
    advanceAuthority(env.ledger, p2.id, "prepare_proof");
    advanceAuthority(env.ledger, p2.id, "release_proof");
    recordFundingFinalized(env.ledger, p2.id, { payout: 300_000n, tokenFees: 10_000n, change: 380_000n, changeCommitment: "d".repeat(64), observedAtMs: T0 });

    // REV-01: pausing after funding stops the merchant signature; the funded wallet becomes recoverable.
    pauseAgent(env.ledger, ws, env.agents.Prince.id, "owner");
    expectDenied(() => advanceAuthority(env.ledger, p2.id, "sign_merchant"), "ACCOUNT_STOPPED");
    emergencyStop(env.ledger, ws, "owner");
    markRecoverable(env.ledger, p2.id, "merchant leg stopped by owner");
    const notesBefore = count(env.ledger, "SELECT count(*) FROM note");
    recordExternalRecovery(env.ledger, p2.id, { recoveredPrincipal: 300_000n, tokenFeesPaid: 10_000n, sponsorLamportsSpent: 0n, observedAtMs: T0 + 60_000 });

    expect(count(env.ledger, "SELECT count(*) FROM note")).toBe(notesBefore);
    expect(tokenBuckets(env.ledger, ws)).toMatchObject({ payout_balance: 0n, external_recovered: 300_000n, merchant_outflow: 300_000n, pending_change: 380_000n });
    const agent = { kind: "agent", id: env.agents.Prince.id } as const;
    const life = lifetimeUsage(env.ledger, agent, "usdc", 2_000_000n);
    // p1's 310,000 plus p2's paid fee; p2's recovered principal is restored, its fee is not.
    expect(life.settled).toBe(320_000n);
    expect(life.reserved).toBe(0n);
    const p2After = getPurchaseRow(env.ledger, p2.id);
    expect(p2After).toMatchObject({ recovery_state: "recovered", merchant_state: "abandoned", funding_state: "finalized" });
  });
});

describe("rolling-window refund rules", () => {
  it("offsets a refund only against its own in-window expense and never below zero", () => {
    env = createEnv();
    activateDefaults(env, { agents: { Prince: { maxPurchaseTestUsdc: "1000000", rolling24hTestUsdc: "1000000" } } });
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 500_000n, fee: 20_000n }]);
    addNotes(env, [520_000n, 1_000_000n]);
    const p = authorize(env, "Prince", "r1", svc).purchase;
    settle(env, p.id, 0n, T0, 20_000n);
    const agent = { kind: "agent", id: env.agents.Prince.id } as const;

    env.clock.t = T0 + 3_600_000;
    recordMerchantRefund(env.ledger, p.id, 200_000n, env.clock.t);
    expect(rollingUsage(env.ledger, agent, "usdc", 1_000_000n, env.clock.t).settled).toBe(320_000n);
    expect(lifetimeUsage(env.ledger, agent, "usdc", 2_000_000n).settled).toBe(320_000n);
    // The 20,000 fee is never restorable: refunds are bounded by the 500,000 principal.
    expect(() => recordMerchantRefund(env.ledger, p.id, 300_001n, env.clock.t)).toThrow(/exceeds the linked expense principal/);

    env.clock.t = T0 + DAY_MS + 1;
    expect(rollingUsage(env.ledger, agent, "usdc", 1_000_000n, env.clock.t).settled).toBe(0n);
    recordMerchantRefund(env.ledger, p.id, 100_000n, env.clock.t);
    expect(rollingUsage(env.ledger, agent, "usdc", 1_000_000n, env.clock.t).settled).toBe(0n);
    expect(lifetimeUsage(env.ledger, agent, "usdc", 2_000_000n).settled).toBe(220_000n);
    // The expired refund does not create extra rolling headroom beyond the full cap.
    const big = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 1_000_000n }]);
    expect(authorize(env, "Prince", "r2", big).created).toBe(true);
    expect(() => env.ledger.db.prepare("UPDATE financial_event SET amount = 0").run()).toThrow(/append-only/);
    expect(() => env.ledger.db.prepare("DELETE FROM financial_event").run()).toThrow(/append-only/);
  });
});

describe("REV-01 pause before signing", () => {
  it("cancels unreleased authority and blocks new authorization; released material stays visible", () => {
    env = createEnv();
    activateDefaults(env);
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [100_000n, 100_000n]);
    const unreleased = authorize(env, "Prince", "u", svc).purchase;
    const released = authorize(env, "Prince", "r", svc).purchase;
    advanceAuthority(env.ledger, released.id, "prepare_proof");
    advanceAuthority(env.ledger, released.id, "release_proof");

    pauseAgent(env.ledger, env.ws.id, env.agents.Prince.id, "owner");
    expect(getPurchaseRow(env.ledger, unreleased.id)).toMatchObject({ authorization_state: "rejected", funding_state: "abandoned" });
    expect(count(env.ledger, "SELECT count(*) FROM note WHERE state = 'approved'")).toBe(1);
    expectDenied(() => authorize(env, "Prince", "n", svc), "ACCOUNT_STOPPED");
    expectDenied(() => advanceAuthority(env.ledger, released.id, "submit_withdrawal"), "ACCOUNT_STOPPED");
    const stillLive = getPurchaseRow(env.ledger, released.id);
    expect(stillLive.funding_state).toBe("proof_released");
    expect(count(env.ledger, "SELECT count(*) FROM reservation WHERE purchase_id = ? AND status = 'active'", released.id)).toBe(1);
  });

  it("workspace emergency stop blocks every agent", () => {
    env = createEnv();
    activateDefaults(env);
    const svc = addService(env, [{ sku: "analyze", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [100_000n]);
    emergencyStop(env.ledger, env.ws.id, "owner");
    expectDenied(() => authorize(env, "Mira", "m", svc, { sku: "analyze" }), "ACCOUNT_STOPPED", /emergency stop/);
  });
});

describe("leased jobs", () => {
  it("dedupes trigger keys, leases with compare-and-set and moves expired leases to reconciliation", () => {
    env = createEnv();
    activateDefaults(env);
    const shawn = env.agents.Shawn.id;
    const a = enqueueJob(env.ledger, { workspaceId: env.ws.id, agentId: shawn, kind: "credit_check", triggerKey: "low:acct:1" });
    const b = enqueueJob(env.ledger, { workspaceId: env.ws.id, agentId: shawn, kind: "credit_check", triggerKey: "low:acct:1" });
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);

    const claimed = claimNextJob(env.ledger, "w1", 30_000);
    expect(claimed?.state).toBe("leased");
    expect(claimNextJob(env.ledger, "w2", 30_000)).toBeNull();
    expectDenied(() => heartbeatJob(env.ledger, claimed!.id, "w2", claimed!.version, 30_000), "IDEMPOTENCY_CONFLICT");
    expectDenied(() => completeJob(env.ledger, claimed!.id, "w2", claimed!.version, "completed", {}), "IDEMPOTENCY_CONFLICT");
    const hb = heartbeatJob(env.ledger, claimed!.id, "w1", claimed!.version, 30_000);
    expectDenied(() => completeJob(env.ledger, claimed!.id, "w1", claimed!.version, "completed", {}), "IDEMPOTENCY_CONFLICT");
    expectDenied(() => heartbeatJob(env.ledger, claimed!.id, "w1", claimed!.version, 30_000), "IDEMPOTENCY_CONFLICT");

    env.clock.t += 31_000;
    expectDenied(() => completeJob(env.ledger, claimed!.id, "w1", hb.version, "completed", {}), "IDEMPOTENCY_CONFLICT");
    expect(expireLeases(env.ledger)).toEqual([claimed!.id]);
    expectDenied(() => completeJob(env.ledger, claimed!.id, "w1", hb.version, "completed", {}), "IDEMPOTENCY_CONFLICT");
    expect(claimNextJob(env.ledger, "w1", 30_000)).toBeNull();
    expect(count(env.ledger, "SELECT count(*) FROM job")).toBe(1);
  });

  it("cancels jobs whose agent epoch moved", () => {
    env = createEnv();
    activateDefaults(env);
    enqueueJob(env.ledger, { workspaceId: env.ws.id, agentId: env.agents.Shawn.id, kind: "credit_check", triggerKey: "k" });
    pauseAgent(env.ledger, env.ws.id, env.agents.Shawn.id, "owner");
    expect(claimNextJob(env.ledger, "w", 1000)).toBeNull();
    expect(count(env.ledger, "SELECT count(*) FROM job WHERE state = 'cancelled'")).toBe(1);
  });
});
