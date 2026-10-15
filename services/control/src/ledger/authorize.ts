import { checkedAdd, type PaymentPath } from "@veilo/contracts";
import { immediate } from "@veilo/db";
import { big, num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { fits, lifetimeUsage, rollingUsage, type Scope } from "./accounting";
import { appendFinancialEvent, enqueueOutbox, redactText, writeAudit } from "./events";
import { reserveNote } from "./notes";
import { getPurchaseRow, type PurchaseRow } from "./purchases";
import {
  activeAgentPolicy,
  activeWorkspacePolicy,
  agentPermissions,
  getAgent,
  type PolicyRow,
  type WorkspaceRow,
} from "./workspace";

export interface AuthorizeInput {
  workspaceId: string;
  /** Always taken from the authenticated worker credential. */
  agentId: string;
  idempotencyKey: string;
  serviceId: string;
  sku: string;
  paymentPath: PaymentPath;
  requestDigest: string;
  taskId?: string | undefined;
  jobId?: string | undefined;
  rationale?: string | undefined;
}

export interface AuthorizeResult {
  purchase: PurchaseRow;
  /** False when an identical logical purchase already existed. */
  created: boolean;
}

interface TaskRow {
  id: string;
  agent_id: string;
  workspace_id: string;
  limit_usdc: bigint;
  usage_limit_units: bigint;
  deadline_at_ms: bigint | null;
  max_purchases: bigint;
  purchase_count: bigint;
  state: string;
}

interface SkuRow {
  service_id: string;
  service_status: string;
  service_workspace: string;
  network: string;
  mint: string;
  sku: string;
  payment_path: PaymentPath;
  price_usdc: bigint;
  max_fee_usdc: bigint;
  usage_units: bigint;
  sponsor_lamports: bigint;
  enabled: bigint;
}

function requireTierAllowsSpend(policy: PolicyRow, label: string, nowMs: number): void {
  if (policy.tier === "stopped") throw new ControlError("ACCOUNT_STOPPED", `${label} policy is stopped; reconcile only`);
  if (policy.tier === "observe") throw new ControlError("POLICY_DENIED", `${label} policy is observe-only; planning without purchases`);
  if (policy.expires_at_ms !== null && num(policy.expires_at_ms) <= nowMs) {
    throw new ControlError("POLICY_DENIED", `${label} policy has expired`);
  }
}

function sameLogicalPurchase(p: PurchaseRow, input: AuthorizeInput): boolean {
  return (
    p.service_id === input.serviceId &&
    p.sku === input.sku &&
    p.payment_path === input.paymentPath &&
    p.request_digest === input.requestDigest &&
    (p.task_id ?? undefined) === input.taskId
  );
}

/**
 * Atomic authorization. One BEGIN IMMEDIATE transaction rechecks workspace, agent, task, service
 * and note availability against every scope, then creates the reservation and the unique purchase
 * operation with its policy snapshot. A repeated logical purchase returns the existing operation.
 */
export function authorizePurchase(ledger: Ledger, input: AuthorizeInput): AuthorizeResult {
  try {
    return immediate(ledger.db, () => authorizeInTransaction(ledger, input));
  } catch (error) {
    if (error instanceof ControlError) {
      immediate(ledger.db, () =>
        writeAudit(ledger, {
          workspaceId: input.workspaceId,
          scope: `agent:${input.agentId}`,
          actorType: "worker",
          actorId: input.agentId,
          action: "purchase.authorize",
          policyResult: "denied",
          reasonCode: error.code,
          details: { sku: input.sku, paymentPath: input.paymentPath, taskId: input.taskId ?? null, reason: error.message },
        }),
      );
    }
    throw error;
  }
}

function authorizeInTransaction(ledger: Ledger, input: AuthorizeInput): AuthorizeResult {
  const { db } = ledger;
  const now = ledger.now();

  const existing = db
    .prepare(`SELECT * FROM purchase WHERE workspace_id = ? AND agent_id = ? AND idempotency_key = ?`)
    .get(input.workspaceId, input.agentId, input.idempotencyKey) as PurchaseRow | undefined;
  if (existing) {
    if (!sameLogicalPurchase(existing, input)) {
      throw new ControlError("IDEMPOTENCY_CONFLICT", "this purchase key was already used with a different request");
    }
    return { purchase: existing, created: false };
  }

  const ws = db.prepare(`SELECT * FROM workspace WHERE id = ?`).get(input.workspaceId) as WorkspaceRow | undefined;
  if (!ws) throw new ControlError("NOT_FOUND", "workspace not found");
  if (ws.stopped === 1n) throw new ControlError("ACCOUNT_STOPPED", "workspace emergency stop is active");
  const wsPolicy = activeWorkspacePolicy(ledger, ws.id);
  if (!wsPolicy) throw new ControlError("POLICY_DENIED", "workspace policy has not been activated by the owner");
  requireTierAllowsSpend(wsPolicy, "workspace", now);

  const agent = getAgent(ledger, input.agentId);
  if (!agent || agent.workspace_id !== ws.id) throw new ControlError("POLICY_DENIED", "agent scope mismatch");
  if (agent.status !== "active") throw new ControlError("ACCOUNT_STOPPED", `agent is ${agent.status}`);
  const agentPolicy = activeAgentPolicy(ledger, agent.id);
  if (!agentPolicy) throw new ControlError("POLICY_DENIED", "agent policy has not been activated by the owner");
  requireTierAllowsSpend(agentPolicy, "agent", now);

  let task: TaskRow | undefined;
  if (input.taskId !== undefined) {
    task = db.prepare(`SELECT * FROM task WHERE id = ?`).get(input.taskId) as TaskRow | undefined;
    if (!task || task.agent_id !== agent.id) throw new ControlError("POLICY_DENIED", "task scope mismatch");
    if (task.state !== "queued" && task.state !== "running") throw new ControlError("POLICY_DENIED", `task is ${task.state}`);
    if (task.deadline_at_ms !== null && num(task.deadline_at_ms) <= now) {
      throw new ControlError("POLICY_DENIED", "task deadline has passed");
    }
    if (task.purchase_count >= task.max_purchases) {
      throw new ControlError("BUDGET_EXCEEDED", "task paid-purchase count limit reached");
    }
  }

  const sku = db
    .prepare(
      `SELECT s.service_id, a.status AS service_status, a.workspace_id AS service_workspace, a.network, a.mint, s.sku,
              s.payment_path, s.price_usdc, s.max_fee_usdc, s.usage_units, s.sponsor_lamports, s.enabled
       FROM service_sku s JOIN approved_service a ON a.id = s.service_id
       WHERE s.service_id = ? AND s.sku = ? AND s.payment_path = ?`,
    )
    .get(input.serviceId, input.sku, input.paymentPath) as SkuRow | undefined;
  if (!sku || sku.service_workspace !== ws.id) throw new ControlError("SERVICE_NOT_ALLOWED", "service SKU is not in the approved catalog");
  if (sku.service_status !== "approved" || sku.enabled !== 1n) {
    throw new ControlError("SERVICE_NOT_ALLOWED", "service binding is not approved or the SKU is disabled");
  }
  if (sku.network !== ws.network) throw new ControlError("WRONG_NETWORK", "service network differs from the workspace network");
  if (sku.mint !== ws.mint) throw new ControlError("WRONG_MINT", "service mint differs from the workspace mint");
  const perms = agentPermissions(agentPolicy);
  if (!perms.allowedSkus.includes(sku.sku) || !perms.allowedPaymentPaths.includes(sku.payment_path)) {
    throw new ControlError("SERVICE_NOT_ALLOWED", "agent policy does not permit this SKU or payment path");
  }

  const exposure = checkedAdd(big(sku.price_usdc), big(sku.max_fee_usdc));
  const lamports = big(sku.sponsor_lamports);
  const units = big(sku.usage_units);

  if (exposure > big(agentPolicy.per_purchase_limit_usdc)) {
    throw new ControlError("BUDGET_EXCEEDED", "price plus fee cap exceeds the per-purchase limit");
  }

  const agentScope: Scope = { kind: "agent", id: agent.id };
  const wsScope: Scope = { kind: "workspace", id: ws.id };
  const checks: Array<[boolean, string]> = [];
  if (exposure > 0n) {
    if (task) checks.push([fits(lifetimeUsage(ledger, { kind: "task", id: task.id }, "usdc", big(task.limit_usdc)), exposure), "task budget"]);
    checks.push([fits(lifetimeUsage(ledger, agentScope, "usdc", big(agentPolicy.lifetime_limit_usdc)), exposure), "agent lifetime allocation"]);
    checks.push([fits(rollingUsage(ledger, agentScope, "usdc", big(agentPolicy.rolling_24h_limit_usdc), now), exposure), "agent rolling 24-hour cap"]);
    checks.push([fits(lifetimeUsage(ledger, wsScope, "usdc", big(wsPolicy.lifetime_limit_usdc)), exposure), "workspace lifetime allocation"]);
    checks.push([fits(rollingUsage(ledger, wsScope, "usdc", big(wsPolicy.rolling_24h_limit_usdc), now), exposure), "workspace rolling 24-hour cap"]);
  }
  if (lamports > 0n) {
    checks.push([fits(lifetimeUsage(ledger, wsScope, "lamports", big(wsPolicy.sponsor_lamport_limit)), lamports), "sponsor lamport allowance"]);
  }
  if (units > 0n) {
    if (task) checks.push([fits(lifetimeUsage(ledger, { kind: "task", id: task.id }, "usage_units", big(task.usage_limit_units)), units), "task usage cap"]);
    checks.push([fits(lifetimeUsage(ledger, agentScope, "usage_units", big(agentPolicy.usage_allowance_units)), units), "agent usage allowance"]);
  }
  const failed = checks.find(([ok]) => !ok);
  if (failed) throw new ControlError("BUDGET_EXCEEDED", `${failed[1]} would be exceeded`);

  const needsApproval =
    wsPolicy.tier === "approval_required" ||
    (agentPolicy.tier === "approval_required" &&
      (agentPolicy.approval_threshold_usdc === null || exposure >= big(agentPolicy.approval_threshold_usdc)));

  const purchaseId = ledger.newId();
  const operationId = ledger.newId();
  const isPrivate = input.paymentPath === "private_x402";
  const snapshot = {
    workspacePolicy: { id: wsPolicy.id, version: num(wsPolicy.version), tier: wsPolicy.tier },
    agentPolicy: { id: agentPolicy.id, version: num(agentPolicy.version), tier: agentPolicy.tier },
    limits: {
      perPurchase: big(agentPolicy.per_purchase_limit_usdc).toString(),
      agentLifetime: big(agentPolicy.lifetime_limit_usdc).toString(),
      agentRolling24h: big(agentPolicy.rolling_24h_limit_usdc).toString(),
      workspaceLifetime: big(wsPolicy.lifetime_limit_usdc).toString(),
      workspaceRolling24h: big(wsPolicy.rolling_24h_limit_usdc).toString(),
      sponsorLamports: big(wsPolicy.sponsor_lamport_limit).toString(),
      taskLimit: task ? big(task.limit_usdc).toString() : null,
    },
  };
  db.prepare(
    `INSERT INTO purchase (id, workspace_id, operation_id, idempotency_key, agent_id, task_id, job_id, service_id, sku,
       payment_path, request_digest, price_usdc, fee_cap_usdc, sponsor_lamports, usage_units, policy_snapshot_json,
       workspace_policy_version, agent_policy_version, agent_epoch, stop_epoch, rationale, authorization_state,
       funding_state, merchant_state, fulfilment_state, recovery_state, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started', 'none', ?, ?)`,
  ).run(
    purchaseId,
    ws.id,
    operationId,
    input.idempotencyKey,
    agent.id,
    input.taskId ?? null,
    input.jobId ?? null,
    sku.service_id,
    sku.sku,
    sku.payment_path,
    input.requestDigest,
    sku.price_usdc,
    sku.max_fee_usdc,
    lamports,
    units,
    JSON.stringify(snapshot),
    wsPolicy.version,
    agentPolicy.version,
    agent.revocation_epoch,
    ws.emergency_stop_epoch,
    input.rationale === undefined ? null : redactText(input.rationale),
    needsApproval ? "awaiting_approval" : "reserved",
    isPrivate ? "not_started" : "not_required",
    isPrivate ? "not_started" : "not_required",
    now,
    now,
  );

  db.prepare(
    `INSERT INTO reservation (id, purchase_id, workspace_id, agent_id, task_id, reserved_usdc, reserved_lamports,
       reserved_usage_units, status, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(ledger.newId(), purchaseId, ws.id, agent.id, input.taskId ?? null, exposure, lamports, units, now);

  for (const [asset, amount] of [["usdc", exposure], ["lamports", lamports], ["usage_units", units]] as const) {
    if (amount === 0n) continue;
    appendFinancialEvent(ledger, {
      workspaceId: ws.id,
      agentId: agent.id,
      taskId: input.taskId ?? null,
      purchaseId,
      kind: "reservation_opened",
      asset,
      amount,
      occurredAtMs: now,
    });
  }

  if (isPrivate) reserveNote(ledger, ws.id, purchaseId, exposure);
  if (task) db.prepare(`UPDATE task SET purchase_count = purchase_count + 1, updated_at_ms = ? WHERE id = ?`).run(now, task.id);

  writeAudit(ledger, {
    workspaceId: ws.id,
    scope: `agent:${agent.id}`,
    actorType: "worker",
    actorId: agent.id,
    action: "purchase.authorize",
    policyResult: "allowed",
    reasonCode: needsApproval ? "APPROVAL_REQUIRED" : null,
    details: { purchaseId, operationId, sku: sku.sku, paymentPath: sku.payment_path, exposureUsdc: exposure, usageUnits: units },
  });
  enqueueOutbox(ledger, "purchase.authorized", purchaseId, {
    purchaseId,
    operationId,
    paymentPath: sku.payment_path,
    awaitingApproval: needsApproval,
  });

  return { purchase: getPurchaseRow(ledger, purchaseId), created: true };
}
