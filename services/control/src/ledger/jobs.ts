import { immediate } from "@veilo/db";
import { num, optIso, iso, type Ledger } from "../context";
import { ControlError } from "../errors";

export type JobKind = "credit_check" | "research" | "content" | "reconcile";
export type JobState = "queued" | "leased" | "completed" | "failed" | "reconciling" | "cancelled";

export interface JobRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  task_id: string | null;
  kind: JobKind;
  trigger_key: string;
  scheduled_at_ms: bigint;
  agent_epoch: bigint;
  state: JobState;
  lease_owner: string | null;
  lease_expires_at_ms: bigint | null;
  heartbeat_at_ms: bigint | null;
  attempt_count: bigint;
  version: bigint;
  result_json: string | null;
}

export function getJob(ledger: Ledger, id: string): JobRow {
  const row = ledger.db.prepare(`SELECT * FROM job WHERE id = ?`).get(id) as JobRow | undefined;
  if (!row) throw new ControlError("NOT_FOUND", "job not found");
  return row;
}

/** Enqueues a job; a repeated trigger key returns the existing job instead of a new one. */
export function enqueueJob(
  ledger: Ledger,
  input: { workspaceId: string; agentId: string; taskId?: string | null; kind: JobKind; triggerKey: string; scheduledAtMs?: number },
): { job: JobRow; created: boolean } {
  return immediate(ledger.db, () => {
    const existing = ledger.db.prepare(`SELECT * FROM job WHERE trigger_key = ?`).get(input.triggerKey) as JobRow | undefined;
    if (existing) {
      if (existing.agent_id !== input.agentId) throw new ControlError("IDEMPOTENCY_CONFLICT", "trigger key belongs to another agent");
      return { job: existing, created: false };
    }
    const agent = ledger.db.prepare(`SELECT revocation_epoch, status FROM agent WHERE id = ?`).get(input.agentId) as
      | { revocation_epoch: bigint; status: string }
      | undefined;
    if (!agent) throw new ControlError("NOT_FOUND", "agent not found");
    if (agent.status !== "active") throw new ControlError("ACCOUNT_STOPPED", `agent is ${agent.status}`);
    const id = ledger.newId();
    const now = ledger.now();
    ledger.db
      .prepare(
        `INSERT INTO job (id, workspace_id, agent_id, task_id, kind, trigger_key, scheduled_at_ms, agent_epoch, state,
           created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(id, input.workspaceId, input.agentId, input.taskId ?? null, input.kind, input.triggerKey, input.scheduledAtMs ?? now, agent.revocation_epoch, now, now);
    return { job: getJob(ledger, id), created: true };
  });
}

/**
 * Claims the oldest due job with a compare-and-set on its version. A job whose agent epoch
 * moved since scheduling is cancelled rather than run with stale authority.
 */
export function claimNextJob(ledger: Ledger, workerId: string, leaseMs: number, agentId?: string): JobRow | null {
  return immediate(ledger.db, () => {
    const now = ledger.now();
    const candidates = ledger.db
      .prepare(
        `SELECT j.*, a.revocation_epoch AS current_epoch, a.status AS agent_status FROM job j JOIN agent a ON a.id = j.agent_id
         WHERE j.state = 'queued' AND j.scheduled_at_ms <= ? AND (? IS NULL OR j.agent_id = ?)
         ORDER BY j.scheduled_at_ms, j.created_at_ms LIMIT 20`,
      )
      .all(now, agentId ?? null, agentId ?? null) as Array<JobRow & { current_epoch: bigint; agent_status: string }>;
    for (const job of candidates) {
      if (job.current_epoch !== job.agent_epoch || job.agent_status !== "active") {
        ledger.db
          .prepare(`UPDATE job SET state = 'cancelled', version = version + 1, updated_at_ms = ? WHERE id = ? AND version = ?`)
          .run(now, job.id, job.version);
        continue;
      }
      const r = ledger.db
        .prepare(
          `UPDATE job SET state = 'leased', lease_owner = ?, lease_expires_at_ms = ?, heartbeat_at_ms = ?,
             attempt_count = attempt_count + 1, version = version + 1, updated_at_ms = ?
           WHERE id = ? AND version = ? AND state = 'queued'`,
        )
        .run(workerId, now + leaseMs, now, now, job.id, job.version);
      if (r.changes === 1) return getJob(ledger, job.id);
    }
    return null;
  });
}

/** Extends a lease only for its current owner while it is still unexpired. */
export function heartbeatJob(ledger: Ledger, jobId: string, workerId: string, version: bigint, leaseMs: number): JobRow {
  return immediate(ledger.db, () => {
    const now = ledger.now();
    const r = ledger.db
      .prepare(
        `UPDATE job SET lease_expires_at_ms = ?, heartbeat_at_ms = ?, version = version + 1, updated_at_ms = ?
         WHERE id = ? AND version = ? AND state = 'leased' AND lease_owner = ? AND lease_expires_at_ms > ?`,
      )
      .run(now + leaseMs, now, now, jobId, version, workerId, now);
    if (r.changes !== 1) throw new ControlError("IDEMPOTENCY_CONFLICT", "lease is no longer held by this worker");
    return getJob(ledger, jobId);
  });
}

export function completeJob(
  ledger: Ledger,
  jobId: string,
  workerId: string,
  version: bigint,
  outcome: "completed" | "failed",
  result: Record<string, unknown>,
): JobRow {
  return immediate(ledger.db, () => {
    const now = ledger.now();
    const r = ledger.db
      .prepare(
        `UPDATE job SET state = ?, result_json = ?, version = version + 1, updated_at_ms = ?
         WHERE id = ? AND version = ? AND state = 'leased' AND lease_owner = ? AND lease_expires_at_ms > ?`,
      )
      .run(outcome, JSON.stringify(result), now, jobId, version, workerId, now);
    if (r.changes !== 1) throw new ControlError("IDEMPOTENCY_CONFLICT", "lease is no longer held by this worker");
    return getJob(ledger, jobId);
  });
}

/**
 * Expired leases move to reconciliation. The job is not re-queued: any financial operation it
 * started must be reconciled through its existing operation, never recreated.
 */
export function expireLeases(ledger: Ledger): string[] {
  return immediate(ledger.db, () => {
    const now = ledger.now();
    const expired = ledger.db
      .prepare(`SELECT id, version FROM job WHERE state = 'leased' AND lease_expires_at_ms <= ?`)
      .all(now) as Array<{ id: string; version: bigint }>;
    const moved: string[] = [];
    for (const j of expired) {
      const r = ledger.db
        .prepare(`UPDATE job SET state = 'reconciling', version = version + 1, updated_at_ms = ? WHERE id = ? AND version = ? AND state = 'leased'`)
        .run(now, j.id, j.version);
      if (r.changes === 1) moved.push(j.id);
    }
    return moved;
  });
}

export function jobView(j: JobRow): Record<string, unknown> {
  return {
    id: j.id,
    agentId: j.agent_id,
    taskId: j.task_id,
    kind: j.kind,
    triggerKey: j.trigger_key,
    state: j.state,
    scheduledAt: iso(j.scheduled_at_ms),
    leaseExpiresAt: optIso(j.lease_expires_at_ms),
    attempts: num(j.attempt_count),
  };
}
