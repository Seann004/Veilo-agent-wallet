import { creditManagerConfigSchema } from "@veilo/contracts";
import { immediate } from "@veilo/db";
import { num, type Ledger } from "../context";
import { runCreditCheck, type CreditCheckResult } from "../agents/shawn";
import type { GatewayClient } from "../integration/gateway-client";
import type { PurchaseOrchestrator } from "../integration/orchestrator";
import { writeAudit } from "../ledger/events";
import { claimNextJob, completeJob, enqueueJob, expireLeases, heartbeatJob, type JobRow } from "../ledger/jobs";
import { activeAgentPolicy, type AgentRow } from "../ledger/workspace";

export interface SchedulerDeps {
  ledger: Ledger;
  gateway: GatewayClient | undefined;
  orchestrator: PurchaseOrchestrator;
  workerId?: string;
  leaseMs?: number;
  log?: (line: string) => void;
}

/** Trigger key for an owner "Check now" that also retries after a rejected episode. */
export const RETRY_MARKER = ":retry:";

/**
 * The single durable scheduler. Poll triggers are keyed by agent, revocation epoch, policy
 * version and poll slot, so a repeated tick in the same slot is a no-op. Only the current slot
 * is ever enqueued and only when no check is already queued or running, so downtime coalesces
 * into one observation instead of a backlog of missed checks.
 */
export class Scheduler {
  readonly workerId: string;
  readonly leaseMs: number;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(readonly deps: SchedulerDeps) {
    this.workerId = deps.workerId ?? "control-scheduler";
    this.leaseMs = deps.leaseMs ?? 60_000;
  }

  #creditAgents(): AgentRow[] {
    return this.deps.ledger.db.prepare(`SELECT * FROM agent WHERE role = 'credit_manager' AND status = 'active'`).all() as AgentRow[];
  }

  enqueueDueChecks(): string[] {
    const { ledger } = this.deps;
    const created: string[] = [];
    for (const agent of this.#creditAgents()) {
      const policy = activeAgentPolicy(ledger, agent.id);
      if (!policy) continue;
      const cfg = creditManagerConfigSchema.safeParse(JSON.parse(policy.config_json));
      if (!cfg.success) continue;
      const pending = ledger.db
        .prepare(`SELECT count(*) FROM job WHERE agent_id = ? AND kind = 'credit_check' AND state IN ('queued', 'leased')`)
        .pluck()
        .get(agent.id);
      if (num(pending) > 0) continue;
      const slot = Math.floor(ledger.now() / (cfg.data.pollSeconds * 1000));
      const key = `poll:${agent.id}:e${num(agent.revocation_epoch)}:p${num(policy.version)}:${slot}`;
      const r = enqueueJob(ledger, { workspaceId: agent.workspace_id, agentId: agent.id, kind: "credit_check", triggerKey: key });
      if (r.created) created.push(r.job.id);
    }
    return created;
  }

  /** Claims and runs due credit-check jobs under a heartbeated lease. */
  async runCreditJobs(): Promise<Array<{ job: JobRow; result: CreditCheckResult }>> {
    const { ledger } = this.deps;
    const done: Array<{ job: JobRow; result: CreditCheckResult }> = [];
    for (const agent of this.#creditAgents()) {
      for (let i = 0; i < 10; i += 1) {
        const job = claimNextJob(ledger, this.workerId, this.leaseMs, agent.id);
        if (!job) break;
        let current = job;
        const beat = setInterval(() => {
          try {
            current = heartbeatJob(ledger, current.id, this.workerId, current.version, this.leaseMs);
          } catch {
            clearInterval(beat);
          }
        }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
        beat.unref();
        let result: CreditCheckResult;
        try {
          result = await runCreditCheck(this.deps, agent.id, { jobId: job.id, ownerRetry: job.trigger_key.includes(RETRY_MARKER) });
        } catch (error) {
          clearInterval(beat);
          try {
            completeJob(ledger, current.id, this.workerId, current.version, "failed", { error: (error as Error).message });
          } catch {
            // Lease lost; expiry moves the job to reconciliation.
          }
          throw error;
        }
        clearInterval(beat);
        try {
          current = completeJob(ledger, current.id, this.workerId, current.version, "completed", { ...result });
        } catch {
          // Lease lost while running; reconciliation resolves the job's operations.
        }
        done.push({ job: current, result });
      }
    }
    return done;
  }

  /**
   * Expired leases move to reconciliation. Their purchases are driven through the existing
   * operations (never recreated); the job is then closed as failed and its task marked incomplete.
   */
  async reconcileExpired(): Promise<string[]> {
    const { ledger, orchestrator } = this.deps;
    expireLeases(ledger);
    const jobs = ledger.db.prepare(`SELECT * FROM job WHERE state = 'reconciling'`).all() as JobRow[];
    for (const job of jobs) {
      const purchases = await orchestrator.reconcileAll(job.task_id ? { taskId: job.task_id } : { jobId: job.id });
      immediate(ledger.db, () => {
        const r = ledger.db
          .prepare(`UPDATE job SET state = 'failed', result_json = ?, version = version + 1, updated_at_ms = ? WHERE id = ? AND state = 'reconciling'`)
          .run(JSON.stringify({ reconciled: true, reason: "lease expired", purchases }), ledger.now(), job.id);
        if (r.changes === 1 && job.task_id) {
          ledger.db.prepare(`UPDATE task SET state = 'incomplete', updated_at_ms = ? WHERE id = ? AND state IN ('queued', 'running')`).run(ledger.now(), job.task_id);
        }
        writeAudit(ledger, {
          workspaceId: job.workspace_id,
          scope: `agent:${job.agent_id}`,
          actorType: "system",
          actorId: null,
          action: "job.reconciled",
          policyResult: "not_applicable",
          details: { jobId: job.id, purchases },
        });
      });
    }
    return jobs.map((j) => j.id);
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.reconcileExpired();
      this.enqueueDueChecks();
      await this.runCreditJobs();
    } catch (error) {
      this.deps.log?.(`[scheduler] tick failed: ${(error as Error).name}: ${(error as Error).message}`);
    } finally {
      this.#running = false;
    }
  }

  start(intervalMs = 5_000): void {
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }
}
