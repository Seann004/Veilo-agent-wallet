import { immediate } from "@veilo/db";
import type { Ledger } from "../context";
import { ControlError } from "../errors";
import { enqueueOutbox, writeAudit } from "./events";
import { cancelUnreleasedFor } from "./purchases";
import { requireAgent, requireWorkspace, type AgentRow, type WorkspaceRow } from "./workspace";

/**
 * Pause and revoke bump the agent's revocation epoch inside the same serialized transaction
 * that cancels unreleased operations, so any later release check sees the new epoch. Already
 * released proof or signature material is not recalled and remains visible as live exposure.
 */
export function pauseAgent(ledger: Ledger, workspaceId: string, agentId: string, ownerId: string): AgentRow {
  return changeAgentAuthority(ledger, workspaceId, agentId, ownerId, "paused");
}

export function revokeAgent(ledger: Ledger, workspaceId: string, agentId: string, ownerId: string): AgentRow {
  return changeAgentAuthority(ledger, workspaceId, agentId, ownerId, "revoked");
}

function changeAgentAuthority(
  ledger: Ledger,
  workspaceId: string,
  agentId: string,
  ownerId: string,
  status: "paused" | "revoked",
): AgentRow {
  return immediate(ledger.db, () => {
    const agent = requireAgent(ledger, workspaceId, agentId);
    if (agent.status === "revoked" || agent.status === "archived") {
      if (status === "revoked" || agent.status === "archived") return agent;
      throw new ControlError("ACCOUNT_STOPPED", "agent is revoked");
    }
    const now = ledger.now();
    ledger.db
      .prepare(`UPDATE agent SET status = ?, revocation_epoch = revocation_epoch + 1, updated_at_ms = ? WHERE id = ?`)
      .run(status, now, agentId);
    const cancelled = cancelUnreleasedFor(ledger, workspaceId, agentId);
    ledger.db
      .prepare(
        `UPDATE job SET state = 'cancelled', version = version + 1, updated_at_ms = ? WHERE agent_id = ? AND state = 'queued'`,
      )
      .run(now, agentId);
    if (status === "revoked") {
      ledger.db.prepare(`UPDATE worker_credential SET revoked_at_ms = ? WHERE agent_id = ? AND revoked_at_ms IS NULL`).run(now, agentId);
    }
    writeAudit(ledger, {
      workspaceId,
      scope: `agent:${agentId}`,
      actorType: "owner",
      actorId: ownerId,
      action: `agent.${status === "paused" ? "pause" : "revoke"}`,
      policyResult: "not_applicable",
      details: { cancelledUnreleased: cancelled },
    });
    enqueueOutbox(ledger, `agent.${status}`, agentId, { agentId, status });
    return requireAgent(ledger, workspaceId, agentId);
  });
}

export function resumeAgent(ledger: Ledger, workspaceId: string, agentId: string, ownerId: string): AgentRow {
  return immediate(ledger.db, () => {
    const agent = requireAgent(ledger, workspaceId, agentId);
    if (agent.status !== "paused") throw new ControlError("ACCOUNT_STOPPED", `agent is ${agent.status}, not paused`);
    ledger.db.prepare(`UPDATE agent SET status = 'active', updated_at_ms = ? WHERE id = ?`).run(ledger.now(), agentId);
    writeAudit(ledger, {
      workspaceId,
      scope: `agent:${agentId}`,
      actorType: "owner",
      actorId: ownerId,
      action: "agent.resume",
      policyResult: "not_applicable",
    });
    return requireAgent(ledger, workspaceId, agentId);
  });
}

/** Global emergency stop: no new authority anywhere. Recovery and public exit stay available. */
export function emergencyStop(ledger: Ledger, workspaceId: string, ownerId: string, reason?: string): WorkspaceRow {
  return immediate(ledger.db, () => {
    const ws = requireWorkspace(ledger, workspaceId);
    const now = ledger.now();
    ledger.db
      .prepare(`UPDATE workspace SET stopped = 1, emergency_stop_epoch = emergency_stop_epoch + 1, updated_at_ms = ? WHERE id = ?`)
      .run(now, ws.id);
    const cancelled = cancelUnreleasedFor(ledger, ws.id, null);
    ledger.db
      .prepare(`UPDATE job SET state = 'cancelled', version = version + 1, updated_at_ms = ? WHERE workspace_id = ? AND state = 'queued'`)
      .run(now, ws.id);
    writeAudit(ledger, {
      workspaceId: ws.id,
      scope: "workspace",
      actorType: "owner",
      actorId: ownerId,
      action: "workspace.stop",
      policyResult: "not_applicable",
      details: { cancelledUnreleased: cancelled, reason: reason ?? null },
    });
    enqueueOutbox(ledger, "workspace.stopped", ws.id, { workspaceId: ws.id });
    return requireWorkspace(ledger, ws.id);
  });
}

export function resumeWorkspace(ledger: Ledger, workspaceId: string, ownerId: string): WorkspaceRow {
  return immediate(ledger.db, () => {
    const ws = requireWorkspace(ledger, workspaceId);
    ledger.db.prepare(`UPDATE workspace SET stopped = 0, updated_at_ms = ? WHERE id = ?`).run(ledger.now(), ws.id);
    writeAudit(ledger, {
      workspaceId: ws.id,
      scope: "workspace",
      actorType: "owner",
      actorId: ownerId,
      action: "workspace.resume",
      policyResult: "not_applicable",
    });
    return requireWorkspace(ledger, ws.id);
  });
}
