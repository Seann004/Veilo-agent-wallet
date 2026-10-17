import { creditManagerConfigSchema, parseBaseUnits } from "@veilo/contracts";
import { CREDIT_PACK_UNITS, computeRequestDigest } from "@veilo/contracts/gateway";
import { immediate } from "@veilo/db";
import { num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { CREDIT_BALANCE_MAX_AGE_MS } from "../integration/balances";
import { GatewayUnreachableError, type GatewayClient } from "../integration/gateway-client";
import type { PurchaseOrchestrator } from "../integration/orchestrator";
import { authorizePurchase } from "../ledger/authorize";
import { writeAudit } from "../ledger/events";
import { enqueueJob } from "../ledger/jobs";
import { getPurchaseRow } from "../ledger/purchases";
import { activeAgentPolicy, activeWorkspacePolicy, getAgent, requireWorkspace } from "../ledger/workspace";

export type CreditDecision =
  | "sufficient"
  | "paused_balance_unavailable"
  | "paused_stale_balance"
  | "paused_after_rejection"
  | "cooldown"
  | "outstanding_top_up"
  | "top_up_started"
  | "top_up_completed"
  | "rejected"
  | "not_applicable";

export interface CreditCheckResult {
  decision: CreditDecision;
  episodeId: string | null;
  purchaseId: string | null;
  usable: string | null;
  version: string | null;
  sequence: number | null;
  detail: string;
}

interface EpisodeRow {
  id: string;
  agent_id: string;
  account_id: string;
  state: "open" | "completed" | "rejected" | "failed";
  purchase_id: string | null;
  agent_policy_version: bigint;
  workspace_policy_version: bigint;
  stop_epoch: bigint;
  closed_at_ms: bigint | null;
}

export interface CreditCheckDeps {
  ledger: Ledger;
  gateway: GatewayClient | undefined;
  orchestrator: PurchaseOrchestrator;
}

const PACK_SKU = "inference-credit-pack";
const PACK_INPUT = { packs: 1 } as const;

function openEpisode(ledger: Ledger, accountId: string): EpisodeRow | undefined {
  return ledger.db.prepare(`SELECT * FROM credit_episode WHERE account_id = ? AND state = 'open'`).get(accountId) as EpisodeRow | undefined;
}

function lastClosedEpisode(ledger: Ledger, accountId: string): EpisodeRow | undefined {
  return ledger.db
    .prepare(`SELECT * FROM credit_episode WHERE account_id = ? AND state <> 'open' ORDER BY closed_at_ms DESC, created_at_ms DESC LIMIT 1`)
    .get(accountId) as EpisodeRow | undefined;
}

function replenishment(ledger: Ledger, accountId: string): { sequence: number; lastCompletedAtMs: number | null } {
  const row = ledger.db.prepare(`SELECT sequence, last_completed_at_ms FROM credit_replenishment WHERE account_id = ?`).get(accountId) as
    | { sequence: bigint; last_completed_at_ms: bigint | null }
    | undefined;
  return { sequence: row ? num(row.sequence) : 0, lastCompletedAtMs: row?.last_completed_at_ms === null || row?.last_completed_at_ms === undefined ? null : num(row.last_completed_at_ms) };
}

/**
 * Closes an episode from its purchase's durable state. The replenishment sequence advances
 * only here, in the same transaction that records the completed episode, and a single
 * follow-up check is scheduled under a trigger key unique to the episode.
 */
export function settleEpisode(ledger: Ledger, episodeId: string): EpisodeRow {
  return immediate(ledger.db, () => {
    const ep = ledger.db.prepare(`SELECT * FROM credit_episode WHERE id = ?`).get(episodeId) as EpisodeRow;
    if (ep.state !== "open" || ep.purchase_id === null) return ep;
    const p = getPurchaseRow(ledger, ep.purchase_id);
    const now = ledger.now();
    const close = (state: "rejected" | "failed", code: string, reason: string) =>
      ledger.db
        .prepare(`UPDATE credit_episode SET state = ?, reason_code = ?, reason = ?, closed_at_ms = ? WHERE id = ? AND state = 'open'`)
        .run(state, code, reason, now, ep.id);
    if (p.fulfilment_state === "delivered" && p.merchant_state === "finalized") {
      const exec = ledger.db.prepare(`SELECT result_json FROM purchase_execution WHERE purchase_id = ?`).pluck().get(p.id) as string | null | undefined;
      const result = exec ? (JSON.parse(exec) as { issuanceId?: string; issuedUnits?: string }) : {};
      if (!result.issuanceId || result.issuedUnits !== CREDIT_PACK_UNITS.toString()) return ep;
      const seq = replenishment(ledger, ep.account_id).sequence + 1;
      ledger.db
        .prepare(`INSERT OR IGNORE INTO credit_replenishment (account_id, sequence, updated_at_ms) VALUES (?, 0, ?)`)
        .run(ep.account_id, now);
      ledger.db
        .prepare(`UPDATE credit_replenishment SET sequence = sequence + 1, last_episode_id = ?, last_completed_at_ms = ?, updated_at_ms = ? WHERE account_id = ?`)
        .run(ep.id, now, now, ep.account_id);
      ledger.db
        .prepare(`UPDATE credit_episode SET state = 'completed', sequence = ?, reason_code = NULL, reason = ?, closed_at_ms = ? WHERE id = ? AND state = 'open'`)
        .run(seq, `issuance ${result.issuanceId}`, now, ep.id);
      writeAudit(ledger, {
        workspaceId: p.workspace_id,
        scope: `agent:${ep.agent_id}`,
        actorType: "system",
        actorId: null,
        action: "credit.top_up_completed",
        policyResult: "allowed",
        details: { episodeId: ep.id, sequence: seq, purchaseId: p.id, issuedUnits: result.issuedUnits },
      });
      const agent = getAgent(ledger, ep.agent_id);
      if (agent?.status === "active") {
        enqueueJob(ledger, { workspaceId: p.workspace_id, agentId: ep.agent_id, kind: "credit_check", triggerKey: `reeval:${ep.id}` });
      }
    } else if (p.authorization_state === "rejected") {
      close("rejected", "POLICY_DENIED", p.state_reason ?? "purchase was rejected or cancelled");
    } else if (p.recovery_state !== "none" || p.funding_state === "expired_unsettled" || p.fulfilment_state === "paid_without_result" || p.fulfilment_state === "abandoned") {
      close("failed", "RECOVERY_REQUIRED", "top-up did not deliver credits; see the purchase for recovery status");
    }
    return ledger.db.prepare(`SELECT * FROM credit_episode WHERE id = ?`).get(ep.id) as EpisodeRow;
  });
}

function result(decision: CreditDecision, detail: string, extra: Partial<CreditCheckResult> = {}): CreditCheckResult {
  return { decision, episodeId: null, purchaseId: null, usable: null, version: null, sequence: null, detail, ...extra };
}

/**
 * Deterministic low-credit check; no model call. Scheduled polls and "Check now" both run it.
 * A stale or unreadable balance pauses the check. An unresolved episode is reused, never
 * duplicated. A rejected or failed episode pauses new top-ups until a policy/stop-epoch change
 * or an explicit owner retry.
 */
export async function runCreditCheck(deps: CreditCheckDeps, agentId: string, opts: { jobId?: string; ownerRetry?: boolean } = {}): Promise<CreditCheckResult> {
  const { ledger, gateway, orchestrator } = deps;
  const agent = getAgent(ledger, agentId);
  if (!agent || agent.role !== "credit_manager") return result("not_applicable", "agent is not a credit manager");
  const out = await evaluate(deps, agentId, opts);
  immediate(ledger.db, () =>
    writeAudit(ledger, {
      workspaceId: agent.workspace_id,
      scope: `agent:${agentId}`,
      actorType: "system",
      actorId: null,
      action: "credit.check",
      policyResult: out.decision === "rejected" ? "denied" : "not_applicable",
      reasonCode: out.decision,
      details: { ...out, gatewayConfigured: gateway !== undefined, orchestrator: orchestrator.configured },
    }),
  );
  return out;
}

async function evaluate(deps: CreditCheckDeps, agentId: string, opts: { jobId?: string; ownerRetry?: boolean }): Promise<CreditCheckResult> {
  const { ledger, gateway, orchestrator } = deps;
  const agent = getAgent(ledger, agentId);
  if (!agent || agent.status !== "active") return result("not_applicable", `agent is ${agent?.status ?? "missing"}`);
  const policy = activeAgentPolicy(ledger, agentId);
  if (!policy) return result("not_applicable", "agent policy is not active");
  const cfg = creditManagerConfigSchema.safeParse(JSON.parse(policy.config_json));
  if (!cfg.success) return result("not_applicable", "credit manager configuration is missing or invalid");
  if (!gateway) return result("paused_balance_unavailable", "gateway is not configured");

  let balance;
  try {
    balance = await gateway.balance();
  } catch (error) {
    return result("paused_balance_unavailable", error instanceof GatewayUnreachableError ? error.message : "balance read failed");
  }
  const obs = { usable: balance.usable, version: balance.version };
  const age = ledger.now() - Date.parse(balance.asOf);
  if (!Number.isFinite(age) || Math.abs(age) > CREDIT_BALANCE_MAX_AGE_MS) return result("paused_stale_balance", `balance as of ${balance.asOf} is stale`, obs);

  const accountId = balance.accountId;
  const open = openEpisode(ledger, accountId);
  if (open) {
    if (open.purchase_id) await orchestrator.drive(open.purchase_id);
    const settled = settleEpisode(ledger, open.id);
    const decision: CreditDecision = settled.state === "completed" ? "top_up_completed" : settled.state === "open" ? "outstanding_top_up" : "rejected";
    return result(decision, `episode ${settled.state}`, { ...obs, episodeId: open.id, purchaseId: open.purchase_id, sequence: replenishment(ledger, accountId).sequence });
  }

  const ws = requireWorkspace(ledger, agent.workspace_id);
  const wsPolicy = activeWorkspacePolicy(ledger, ws.id);
  const last = lastClosedEpisode(ledger, accountId);
  if (last && (last.state === "rejected" || last.state === "failed") && !opts.ownerRetry) {
    const changed =
      last.agent_policy_version !== policy.version ||
      last.workspace_policy_version !== (wsPolicy?.version ?? 0n) ||
      last.stop_epoch !== ws.emergency_stop_epoch;
    if (!changed) return result("paused_after_rejection", `previous top-up episode was ${last.state}; waiting for a policy change or owner retry`, { ...obs, episodeId: last.id });
  }

  const usable = parseBaseUnits(balance.usable);
  const threshold = parseBaseUnits(cfg.data.creditLowWatermark);
  if (usable >= threshold) return result("sufficient", `usable ${usable} is at or above the threshold ${threshold}`, obs);

  const rep = replenishment(ledger, accountId);
  if (rep.lastCompletedAtMs !== null && ledger.now() < rep.lastCompletedAtMs + cfg.data.cooldownSeconds * 1000) {
    return result("cooldown", `cooldown active until ${new Date(rep.lastCompletedAtMs + cfg.data.cooldownSeconds * 1000).toISOString()}`, { ...obs, sequence: rep.sequence });
  }
  if (parseBaseUnits(cfg.data.creditPackUnits) !== CREDIT_PACK_UNITS) {
    return result("not_applicable", "configured pack size differs from the gateway's fixed pack", obs);
  }
  const serviceId = ledger.db
    .prepare(
      `SELECT s.service_id FROM service_sku s JOIN approved_service a ON a.id = s.service_id
       WHERE a.workspace_id = ? AND s.sku = ? AND s.payment_path = 'private_x402' ORDER BY a.status = 'approved' DESC LIMIT 1`,
    )
    .pluck()
    .get(ws.id, PACK_SKU) as string | undefined;

  const episodeId = ledger.newId();
  const raced = immediate(ledger.db, () => {
    const concurrent = openEpisode(ledger, accountId);
    if (concurrent) return concurrent;
    ledger.db
      .prepare(
        `INSERT INTO credit_episode (id, workspace_id, agent_id, account_id, state, trigger_usable, trigger_version, trigger_as_of,
           agent_policy_version, workspace_policy_version, stop_epoch, created_at_ms) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(episodeId, ws.id, agentId, accountId, usable, balance.version, balance.asOf, policy.version, wsPolicy?.version ?? 0n, ws.emergency_stop_epoch, ledger.now());
    return undefined;
  });
  if (raced) return result("outstanding_top_up", "another check opened the episode", { ...obs, episodeId: raced.id, purchaseId: raced.purchase_id });

  const reject = (code: string, reason: string) => {
    ledger.db
      .prepare(`UPDATE credit_episode SET state = 'rejected', reason_code = ?, reason = ?, closed_at_ms = ? WHERE id = ? AND state = 'open'`)
      .run(code, reason, ledger.now(), episodeId);
    return result("rejected", reason, { ...obs, episodeId });
  };
  if (!serviceId) return reject("SERVICE_NOT_ALLOWED", "credit pack SKU is not in the approved catalog");

  let purchaseId: string;
  try {
    const auth = authorizePurchase(ledger, {
      workspaceId: ws.id,
      agentId,
      idempotencyKey: `credit-episode:${episodeId}`,
      serviceId,
      sku: PACK_SKU,
      paymentPath: "private_x402",
      requestDigest: computeRequestDigest(PACK_SKU, PACK_INPUT),
      jobId: opts.jobId,
      rationale: `usable credits ${usable} below threshold ${threshold} (balance version ${balance.version})`,
    });
    purchaseId = auth.purchase.id;
  } catch (error) {
    if (error instanceof ControlError) return reject(error.code, error.message);
    throw error;
  }
  ledger.db.prepare(`UPDATE credit_episode SET purchase_id = ? WHERE id = ?`).run(purchaseId, episodeId);
  const purchase = getPurchaseRow(ledger, purchaseId);
  orchestrator.storeInput(purchase, { ...PACK_INPUT });
  if (purchase.authorization_state === "awaiting_approval") {
    return result("top_up_started", "top-up awaits owner approval", { ...obs, episodeId, purchaseId });
  }
  await orchestrator.driveUntilSettled(purchaseId);
  const settled = settleEpisode(ledger, episodeId);
  const decision: CreditDecision = settled.state === "completed" ? "top_up_completed" : settled.state === "open" ? "top_up_started" : "rejected";
  return result(decision, `episode ${settled.state}`, { ...obs, episodeId, purchaseId, sequence: replenishment(ledger, accountId).sequence });
}
