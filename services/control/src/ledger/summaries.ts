import { parseBaseUnits } from "@veilo/contracts";
import { immediate } from "@veilo/db";
import { big, iso, num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { lifetimeUsage, rollingUsage, serializeUsage } from "./accounting";
import { writeAudit } from "./events";
import { tokenBuckets } from "./notes";
import {
  activeAgentPolicy,
  activeWorkspacePolicy,
  agentPermissions,
  listAgents,
  type AgentRow,
  type WorkspaceRow,
} from "./workspace";

export function agentBudget(ledger: Ledger, agent: AgentRow): Record<string, unknown> {
  const policy = activeAgentPolicy(ledger, agent.id);
  const now = ledger.now();
  if (!policy) return { agentId: agent.id, status: agent.status, policy: null };
  const scope = { kind: "agent", id: agent.id } as const;
  return {
    agentId: agent.id,
    status: agent.status,
    policyVersion: num(policy.version),
    tier: policy.tier,
    unit: "usdc_base_units",
    maxPurchase: big(policy.per_purchase_limit_usdc).toString(),
    lifetime: serializeUsage(lifetimeUsage(ledger, scope, "usdc", big(policy.lifetime_limit_usdc))),
    rolling24h: serializeUsage(rollingUsage(ledger, scope, "usdc", big(policy.rolling_24h_limit_usdc), now)),
    usageAllowance: {
      unit: "gateway_microcredits",
      ...serializeUsage(lifetimeUsage(ledger, scope, "usage_units", big(policy.usage_allowance_units))),
    },
    permissions: agentPermissions(policy),
  };
}

/**
 * Policy allowance, physical token buckets and sponsor lamports are reported side by side and
 * never added together. Gateway credit balances belong to the gateway ledger.
 */
export function balances(ledger: Ledger, ws: WorkspaceRow): Record<string, unknown> {
  const now = ledger.now();
  const policy = activeWorkspacePolicy(ledger, ws.id);
  const scope = { kind: "workspace", id: ws.id } as const;
  const tokens = tokenBuckets(ledger, ws.id);
  return {
    workspace: policy
      ? {
          policyVersion: num(policy.version),
          tier: policy.tier,
          stopped: ws.stopped === 1n,
          unit: "usdc_base_units",
          lifetime: serializeUsage(lifetimeUsage(ledger, scope, "usdc", big(policy.lifetime_limit_usdc))),
          rolling24h: serializeUsage(rollingUsage(ledger, scope, "usdc", big(policy.rolling_24h_limit_usdc), now)),
          sponsor: { unit: "lamports", ...serializeUsage(lifetimeUsage(ledger, scope, "lamports", big(policy.sponsor_lamport_limit))) },
        }
      : { policyVersion: null, stopped: ws.stopped === 1n, note: "workspace policy not activated" },
    agents: listAgents(ledger, ws.id).map((a) => ({ name: a.name, role: a.role, ...agentBudget(ledger, a) })),
    tokens: {
      unit: "usdc_base_units",
      mint: ws.mint,
      buckets: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, v.toString()])),
    },
    gatewayCredits: {
      available: false,
      code: "NOT_READY",
      message: "gateway credit balances are reported by the gateway ledger, which is not connected yet",
    },
  };
}

export interface CreateTaskInput {
  workspaceId: string;
  agent: AgentRow;
  objective: string;
  input: Record<string, unknown>;
  limitUsdc?: string | undefined;
  deadlineMs?: number | null | undefined;
}

/** Creates an owner-defined task with the agent's default task budget unless the owner sets one. */
export function createTask(ledger: Ledger, t: CreateTaskInput): { id: string } {
  const policy = activeAgentPolicy(ledger, t.agent.id);
  if (!policy) throw new ControlError("POLICY_DENIED", "agent policy has not been activated by the owner");
  const id = ledger.newId();
  const now = ledger.now();
  ledger.db
    .prepare(
      `INSERT INTO task (id, workspace_id, agent_id, objective, input_json, limit_usdc, usage_limit_units, deadline_at_ms,
         state, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      id,
      t.workspaceId,
      t.agent.id,
      t.objective,
      JSON.stringify(t.input),
      t.limitUsdc === undefined ? policy.task_limit_usdc : parseBaseUnits(t.limitUsdc),
      policy.task_usage_limit_units,
      t.deadlineMs ?? null,
      now,
      now,
    );
  return { id };
}

export function saveArtifact(
  ledger: Ledger,
  agent: AgentRow,
  a: {
    taskId: string;
    kind: "research_brief" | "content_draft" | "content_calendar";
    title: string;
    content: string;
    citations: unknown[];
    sourcePurchaseIds: string[];
    artifactId?: string | undefined;
  },
): { id: string; revision: number } {
  return immediate(ledger.db, () => {
    const task = ledger.db.prepare(`SELECT agent_id, workspace_id FROM task WHERE id = ?`).get(a.taskId) as
      | { agent_id: string; workspace_id: string }
      | undefined;
    if (!task || task.agent_id !== agent.id) throw new ControlError("POLICY_DENIED", "task scope mismatch");
    for (const pid of a.sourcePurchaseIds) {
      const owner = ledger.db.prepare(`SELECT agent_id FROM purchase WHERE id = ?`).pluck().get(pid) as string | undefined;
      if (owner !== agent.id) throw new ControlError("POLICY_DENIED", "source purchase scope mismatch");
    }
    const now = ledger.now();
    let id = a.artifactId;
    let revision = 1;
    if (id === undefined) {
      id = ledger.newId();
      ledger.db
        .prepare(
          `INSERT INTO artifact (id, workspace_id, task_id, agent_id, kind, title, current_revision, review_state, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?)`,
        )
        .run(id, task.workspace_id, a.taskId, agent.id, a.kind, a.title, now, now);
    } else {
      const existing = ledger.db.prepare(`SELECT agent_id, task_id, current_revision, review_state FROM artifact WHERE id = ?`).get(id) as
        | { agent_id: string; task_id: string; current_revision: bigint; review_state: string }
        | undefined;
      if (!existing || existing.agent_id !== agent.id || existing.task_id !== a.taskId) {
        throw new ControlError("POLICY_DENIED", "artifact scope mismatch");
      }
      if (existing.review_state === "approved_for_export" || existing.review_state === "archived") {
        throw new ControlError("POLICY_DENIED", "artifact is approved or archived; agents cannot revise it");
      }
      revision = num(existing.current_revision) + 1;
      ledger.db.prepare(`UPDATE artifact SET current_revision = ?, title = ?, updated_at_ms = ? WHERE id = ?`).run(revision, a.title, now, id);
    }
    ledger.db
      .prepare(
        `INSERT INTO artifact_revision (artifact_id, revision, content, citations_json, source_purchase_ids_json, author, created_at_ms)
         VALUES (?, ?, ?, ?, ?, 'agent', ?)`,
      )
      .run(id, revision, a.content, JSON.stringify(a.citations), JSON.stringify(a.sourcePurchaseIds), now);
    writeAudit(ledger, {
      workspaceId: task.workspace_id,
      scope: `agent:${agent.id}`,
      actorType: "worker",
      actorId: agent.id,
      action: "artifact.save",
      policyResult: "allowed",
      details: { artifactId: id, revision, kind: a.kind },
    });
    return { id, revision };
  });
}

export function requestHandoff(ledger: Ledger, agent: AgentRow, h: { artifactId: string; toAgentId: string; note?: string | undefined }): { id: string } {
  return immediate(ledger.db, () => {
    const art = ledger.db.prepare(`SELECT agent_id, workspace_id FROM artifact WHERE id = ?`).get(h.artifactId) as
      | { agent_id: string; workspace_id: string }
      | undefined;
    if (!art || art.agent_id !== agent.id) throw new ControlError("POLICY_DENIED", "artifact scope mismatch");
    const target = ledger.db.prepare(`SELECT workspace_id FROM agent WHERE id = ?`).get(h.toAgentId) as { workspace_id: string } | undefined;
    if (!target || target.workspace_id !== art.workspace_id || h.toAgentId === agent.id) {
      throw new ControlError("POLICY_DENIED", "handoff target is not another agent in this workspace");
    }
    const existing = ledger.db
      .prepare(`SELECT id FROM handoff_request WHERE artifact_id = ? AND to_agent_id = ?`)
      .pluck()
      .get(h.artifactId, h.toAgentId) as string | undefined;
    if (existing) return { id: existing };
    const id = ledger.newId();
    ledger.db
      .prepare(
        `INSERT INTO handoff_request (id, workspace_id, artifact_id, from_agent_id, to_agent_id, note, state, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_owner', ?)`,
      )
      .run(id, art.workspace_id, h.artifactId, agent.id, h.toAgentId, h.note ?? null, ledger.now());
    writeAudit(ledger, {
      workspaceId: art.workspace_id,
      scope: `agent:${agent.id}`,
      actorType: "worker",
      actorId: agent.id,
      action: "handoff.request",
      policyResult: "allowed",
      details: { handoffId: id, toAgentId: h.toAgentId },
    });
    return { id };
  });
}

export function activity(ledger: Ledger, workspaceId: string, limit: number, beforeSeq?: number): Record<string, unknown>[] {
  const rows = ledger.db
    .prepare(
      `SELECT seq, scope, actor_type, actor_id, action, policy_result, reason_code, details_json, created_at_ms FROM audit_event
       WHERE workspace_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`,
    )
    .all(workspaceId, beforeSeq ?? null, beforeSeq ?? null, limit) as Array<{
    seq: bigint;
    scope: string;
    actor_type: string;
    actor_id: string | null;
    action: string;
    policy_result: string;
    reason_code: string | null;
    details_json: string;
    created_at_ms: bigint;
  }>;
  return rows.map((r) => ({
    seq: num(r.seq),
    scope: r.scope,
    actor: { type: r.actor_type, id: r.actor_id },
    action: r.action,
    policyResult: r.policy_result,
    reasonCode: r.reason_code,
    details: JSON.parse(r.details_json) as unknown,
    at: iso(r.created_at_ms),
  }));
}
