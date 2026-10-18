import {
  DEFAULT_AGENTS,
  DEFAULT_SERVICES,
  DEFAULT_WORKSPACE_POLICY,
  parseBaseUnits,
  type AgentPolicyInput,
  type AgentRole,
  type AgentStatus,
  type PolicyTier,
  type WorkspacePolicyInput,
} from "@veilo/contracts";
import { immediate } from "@veilo/db";
import { big, num, optNum, type Ledger } from "../context";
import { ControlError } from "../errors";
import { writeAudit, type ActorType } from "./events";

export interface WorkspaceRow {
  id: string;
  owner_pubkey: string;
  network: string;
  mint: string;
  mint_decimals: bigint;
  policy_version: bigint;
  emergency_stop_epoch: bigint;
  stopped: bigint;
  timezone: string;
  created_at_ms: bigint;
  updated_at_ms: bigint;
}

export interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  policy_version: bigint;
  revocation_epoch: bigint;
  trigger_json: string;
  model_profile: string | null;
  description: string | null;
  target_account_id: string | null;
  template: string | null;
  instructions: string | null;
  created_at_ms: bigint;
  updated_at_ms: bigint;
}

export interface PolicyRow {
  id: string;
  workspace_id: string;
  scope_type: "workspace" | "agent";
  agent_id: string | null;
  version: bigint;
  status: "draft" | "active" | "superseded" | "discarded";
  tier: PolicyTier;
  lifetime_limit_usdc: bigint;
  rolling_24h_limit_usdc: bigint;
  per_purchase_limit_usdc: bigint | null;
  task_limit_usdc: bigint | null;
  sponsor_lamport_limit: bigint | null;
  usage_allowance_units: bigint | null;
  task_usage_limit_units: bigint | null;
  approval_threshold_usdc: bigint | null;
  permissions_json: string;
  config_json: string;
  expires_at_ms: bigint | null;
  created_by: "owner" | "seed";
  created_at_ms: bigint;
  activated_at_ms: bigint | null;
}

export interface AgentPermissions {
  allowedSkus: string[];
  allowedPaymentPaths: string[];
  allowBrowsing: boolean;
}

export function getWorkspace(ledger: Ledger): WorkspaceRow | undefined {
  return ledger.db.prepare(`SELECT * FROM workspace ORDER BY created_at_ms LIMIT 1`).get() as WorkspaceRow | undefined;
}

export function requireWorkspace(ledger: Ledger, id?: string): WorkspaceRow {
  const ws = (
    id === undefined ? getWorkspace(ledger) : ledger.db.prepare(`SELECT * FROM workspace WHERE id = ?`).get(id)
  ) as WorkspaceRow | undefined;
  if (!ws) throw new ControlError("NOT_FOUND", "workspace is not initialized");
  return ws;
}

export function getAgent(ledger: Ledger, agentId: string): AgentRow | undefined {
  return ledger.db.prepare(`SELECT * FROM agent WHERE id = ?`).get(agentId) as AgentRow | undefined;
}

export function requireAgent(ledger: Ledger, workspaceId: string, agentId: string): AgentRow {
  const agent = getAgent(ledger, agentId);
  if (!agent || agent.workspace_id !== workspaceId) throw new ControlError("NOT_FOUND", "agent not found");
  return agent;
}

export function listAgents(ledger: Ledger, workspaceId: string): AgentRow[] {
  return ledger.db.prepare(`SELECT * FROM agent WHERE workspace_id = ? ORDER BY created_at_ms, name`).all(workspaceId) as AgentRow[];
}

export function activeWorkspacePolicy(ledger: Ledger, workspaceId: string): PolicyRow | undefined {
  return ledger.db
    .prepare(`SELECT * FROM policy WHERE workspace_id = ? AND scope_type = 'workspace' AND status = 'active'`)
    .get(workspaceId) as PolicyRow | undefined;
}

export function activeAgentPolicy(ledger: Ledger, agentId: string): PolicyRow | undefined {
  return ledger.db
    .prepare(`SELECT * FROM policy WHERE agent_id = ? AND scope_type = 'agent' AND status = 'active'`)
    .get(agentId) as PolicyRow | undefined;
}

/**
 * Free agent work (model calls on the owner's key, page visits) stops with spending authority:
 * the agent must be active under an unstopped, unexpired policy, and the workspace policy must
 * not have expired. Returns the agent's active policy.
 */
export function requireWorkAuthority(ledger: Ledger, agent: AgentRow): PolicyRow {
  const policy = activeAgentPolicy(ledger, agent.id);
  if (agent.status !== "active" || !policy || policy.tier === "stopped") throw new ControlError("ACCOUNT_STOPPED", "this agent is not active");
  const now = ledger.now();
  const expired = (p: PolicyRow | undefined) => p !== undefined && p.expires_at_ms !== null && num(p.expires_at_ms) <= now;
  if (expired(activeWorkspacePolicy(ledger, agent.workspace_id))) throw new ControlError("POLICY_DENIED", "workspace policy has expired");
  if (expired(policy)) throw new ControlError("POLICY_DENIED", "agent policy has expired");
  return policy;
}

export function listPolicies(ledger: Ledger, workspaceId: string): PolicyRow[] {
  return ledger.db
    .prepare(`SELECT * FROM policy WHERE workspace_id = ? ORDER BY scope_type, agent_id, version`)
    .all(workspaceId) as PolicyRow[];
}

export function agentPermissions(policy: PolicyRow): AgentPermissions {
  const parsed = JSON.parse(policy.permissions_json) as Partial<AgentPermissions>;
  return { allowedSkus: parsed.allowedSkus ?? [], allowedPaymentPaths: parsed.allowedPaymentPaths ?? [], allowBrowsing: parsed.allowBrowsing === true };
}

const isoToMs = (v: string | undefined) => (v === undefined ? null : Date.parse(v));

function nextVersion(ledger: Ledger, workspaceId: string, agentId: string | null): number {
  const max = ledger.db
    .prepare(
      `SELECT ifnull(max(version), 0) FROM policy WHERE workspace_id = ? AND ifnull(agent_id, '') = ifnull(?, '')
       AND scope_type = ?`,
    )
    .pluck()
    .get(workspaceId, agentId, agentId === null ? "workspace" : "agent");
  return num(max) + 1;
}

export function insertWorkspacePolicyDraft(
  ledger: Ledger,
  workspaceId: string,
  input: WorkspacePolicyInput,
  createdBy: "owner" | "seed",
): PolicyRow {
  const id = ledger.newId();
  ledger.db
    .prepare(
      `INSERT INTO policy (id, workspace_id, scope_type, agent_id, version, status, tier, lifetime_limit_usdc,
         rolling_24h_limit_usdc, sponsor_lamport_limit, permissions_json, config_json, expires_at_ms, created_by, created_at_ms)
       VALUES (?, ?, 'workspace', NULL, ?, 'draft', ?, ?, ?, ?, '{}', '{}', ?, ?, ?)`,
    )
    .run(
      id,
      workspaceId,
      nextVersion(ledger, workspaceId, null),
      input.tier,
      parseBaseUnits(input.lifetimeTestUsdc),
      parseBaseUnits(input.rolling24hTestUsdc),
      parseBaseUnits(input.sponsorLamportLimit),
      isoToMs(input.expiresAt),
      createdBy,
      ledger.now(),
    );
  return ledger.db.prepare(`SELECT * FROM policy WHERE id = ?`).get(id) as PolicyRow;
}

export function insertAgentPolicyDraft(
  ledger: Ledger,
  workspaceId: string,
  agentId: string,
  input: AgentPolicyInput,
  createdBy: "owner" | "seed",
): PolicyRow {
  const id = ledger.newId();
  const permissions: AgentPermissions = {
    allowedSkus: [...new Set(input.allowedSkus)],
    allowedPaymentPaths: [...new Set(input.allowedPaymentPaths)],
    allowBrowsing: input.allowBrowsing === true,
  };
  ledger.db
    .prepare(
      `INSERT INTO policy (id, workspace_id, scope_type, agent_id, version, status, tier, lifetime_limit_usdc,
         rolling_24h_limit_usdc, per_purchase_limit_usdc, task_limit_usdc, usage_allowance_units, task_usage_limit_units,
         approval_threshold_usdc, permissions_json, config_json, expires_at_ms, created_by, created_at_ms)
       VALUES (?, ?, 'agent', ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      workspaceId,
      agentId,
      nextVersion(ledger, workspaceId, agentId),
      input.tier,
      parseBaseUnits(input.lifetimeTestUsdc),
      parseBaseUnits(input.rolling24hTestUsdc),
      parseBaseUnits(input.maxPurchaseTestUsdc),
      parseBaseUnits(input.taskLimitTestUsdc),
      parseBaseUnits(input.usageAllowanceUnits),
      parseBaseUnits(input.taskCreditUnits),
      input.approvalThresholdTestUsdc === undefined ? null : parseBaseUnits(input.approvalThresholdTestUsdc),
      JSON.stringify(permissions),
      JSON.stringify(input.roleConfig ?? {}),
      isoToMs(input.expiresAt),
      createdBy,
      ledger.now(),
    );
  return ledger.db.prepare(`SELECT * FROM policy WHERE id = ?`).get(id) as PolicyRow;
}

/**
 * Owner activation of a draft version. The previous active version is superseded in the same
 * transaction. Lowering a limit below existing exposure is allowed: live reservations stay
 * visible and new spending is blocked until exposure resolves.
 */
export function activatePolicyVersion(
  ledger: Ledger,
  workspaceId: string,
  agentId: string | null,
  version: number,
  actor: { type: ActorType; id: string | null },
): PolicyRow {
  return immediate(ledger.db, () => {
    const target = ledger.db
      .prepare(
        `SELECT * FROM policy WHERE workspace_id = ? AND ifnull(agent_id, '') = ifnull(?, '') AND scope_type = ? AND version = ?`,
      )
      .get(workspaceId, agentId, agentId === null ? "workspace" : "agent", version) as PolicyRow | undefined;
    if (!target) throw new ControlError("NOT_FOUND", "policy version not found");
    if (target.status !== "draft") throw new ControlError("POLICY_DENIED", "only a draft policy version can be activated");
    if (agentId !== null) {
      const agent = requireAgent(ledger, workspaceId, agentId);
      if (agent.status === "revoked" || agent.status === "archived") {
        throw new ControlError("ACCOUNT_STOPPED", "agent is revoked or archived");
      }
    }
    const now = ledger.now();
    ledger.db
      .prepare(
        `UPDATE policy SET status = 'superseded', superseded_at_ms = ?
         WHERE workspace_id = ? AND ifnull(agent_id, '') = ifnull(?, '') AND scope_type = ? AND status = 'active'`,
      )
      .run(now, workspaceId, agentId, agentId === null ? "workspace" : "agent");
    ledger.db.prepare(`UPDATE policy SET status = 'active', activated_at_ms = ? WHERE id = ?`).run(now, target.id);
    if (agentId === null) {
      ledger.db.prepare(`UPDATE workspace SET policy_version = ?, updated_at_ms = ? WHERE id = ?`).run(target.version, now, workspaceId);
    } else {
      ledger.db
        .prepare(
          `UPDATE agent SET policy_version = ?, status = CASE WHEN status = 'draft' THEN 'active' ELSE status END,
             updated_at_ms = ? WHERE id = ?`,
        )
        .run(target.version, now, agentId);
    }
    writeAudit(ledger, {
      workspaceId,
      scope: agentId === null ? "workspace" : `agent:${agentId}`,
      actorType: actor.type,
      actorId: actor.id,
      action: "policy.activate",
      policyResult: "allowed",
      details: { version, tier: target.tier },
    });
    return ledger.db.prepare(`SELECT * FROM policy WHERE id = ?`).get(target.id) as PolicyRow;
  });
}

export interface CreateAgentInput {
  name: string;
  role: AgentRole;
  description?: string | undefined;
  trigger?: Record<string, unknown> | undefined;
  modelProfile?: string | undefined;
  template?: string | undefined;
  instructions?: string | undefined;
  policy: AgentPolicyInput;
}

/** Creates a draft agent and draft policy v1. Nothing can spend until the owner activates it. */
export function insertAgent(ledger: Ledger, workspaceId: string, input: CreateAgentInput, createdBy: "owner" | "seed"): AgentRow {
  const id = ledger.newId();
  const now = ledger.now();
  ledger.db
    .prepare(
      `INSERT INTO agent (id, workspace_id, name, role, status, trigger_json, model_profile, description, template, instructions,
         created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      workspaceId,
      input.name,
      input.role,
      JSON.stringify(input.trigger ?? {}),
      input.modelProfile ?? null,
      input.description ?? null,
      input.role === "custom" ? (input.template ?? "generalist") : null,
      input.role === "custom" ? (input.instructions ?? null) : null,
      now,
      now,
    );
  insertAgentPolicyDraft(ledger, workspaceId, id, input.policy, createdBy);
  return getAgent(ledger, id) as AgentRow;
}

export interface WorkspaceIdentity {
  ownerPubkey: string;
  network: string;
  mint: string;
  mintDecimals: number;
}

/**
 * Idempotent seed: one workspace with draft default policies, the three role agents and the
 * fixed service catalog. Re-running never changes existing rows or balances.
 */
export function seedWorkspace(ledger: Ledger, identity: WorkspaceIdentity): { workspace: WorkspaceRow; created: boolean } {
  return immediate(ledger.db, () => {
    const existing = getWorkspace(ledger);
    if (existing) {
      if (existing.owner_pubkey !== identity.ownerPubkey) {
        throw new ControlError("POLICY_DENIED", "workspace already belongs to a different owner");
      }
      if (existing.network !== identity.network) throw new ControlError("WRONG_NETWORK", "workspace network differs");
      if (existing.mint !== identity.mint) throw new ControlError("WRONG_MINT", "workspace mint differs");
      return { workspace: existing, created: false };
    }
    const id = ledger.newId();
    const now = ledger.now();
    ledger.db
      .prepare(
        `INSERT INTO workspace (id, owner_pubkey, network, mint, mint_decimals, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, identity.ownerPubkey, identity.network, identity.mint, identity.mintDecimals, now, now);
    insertWorkspacePolicyDraft(ledger, id, DEFAULT_WORKSPACE_POLICY, "seed");
    for (const agent of DEFAULT_AGENTS) insertAgent(ledger, id, agent, "seed");
    for (const service of DEFAULT_SERVICES) {
      const serviceId = ledger.newId();
      ledger.db
        .prepare(
          `INSERT INTO approved_service (id, workspace_id, service_key, origin, network, mint, status, description,
             created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'unbound', ?, ?, ?)`,
        )
        .run(serviceId, id, service.key, service.origin, identity.network, identity.mint, service.description, now, now);
      for (const sku of service.skus) {
        ledger.db
          .prepare(
            `INSERT INTO service_sku (id, service_id, sku, payment_path, price_usdc, max_fee_usdc, usage_units, sponsor_lamports)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ledger.newId(),
            serviceId,
            sku.sku,
            sku.paymentPath,
            parseBaseUnits(sku.priceUsdc),
            parseBaseUnits(sku.maxFeeUsdc),
            parseBaseUnits(sku.usageUnits),
            parseBaseUnits(sku.sponsorLamports),
          );
      }
    }
    writeAudit(ledger, {
      workspaceId: id,
      scope: "workspace",
      actorType: "system",
      actorId: null,
      action: "workspace.seed",
      policyResult: "not_applicable",
      details: { agents: DEFAULT_AGENTS.map((a) => a.name), policies: "draft" },
    });
    return { workspace: requireWorkspace(ledger, id), created: true };
  });
}

export function policyView(p: PolicyRow): Record<string, unknown> {
  const s = (v: bigint | null) => (v === null ? null : big(v).toString());
  return {
    id: p.id,
    scope: p.scope_type,
    agentId: p.agent_id,
    version: num(p.version),
    status: p.status,
    tier: p.tier,
    lifetimeTestUsdc: s(p.lifetime_limit_usdc),
    rolling24hTestUsdc: s(p.rolling_24h_limit_usdc),
    maxPurchaseTestUsdc: s(p.per_purchase_limit_usdc),
    taskLimitTestUsdc: s(p.task_limit_usdc),
    sponsorLamportLimit: s(p.sponsor_lamport_limit),
    usageAllowanceUnits: s(p.usage_allowance_units),
    taskCreditUnits: s(p.task_usage_limit_units),
    approvalThresholdTestUsdc: s(p.approval_threshold_usdc),
    permissions: JSON.parse(p.permissions_json) as unknown,
    roleConfig: JSON.parse(p.config_json) as unknown,
    expiresAtMs: optNum(p.expires_at_ms),
    createdBy: p.created_by,
  };
}
