import { TASK_RUN_BOUNDS } from "@veilo/contracts";
import { ControlClient, type FetchLike, type RunBounds } from "./control-client";
import type { RoleOutcome } from "./roles/common";
import { runMira } from "./roles/mira";
import { runPrince } from "./roles/prince";
import type { SafeFetchPolicy } from "./safe-fetch";

export interface AgentCredential {
  agentId: string;
  role: "research" | "content";
  token: string;
}

export interface WorkerOptions {
  controlUrl: string;
  workerId: string;
  leaseMs?: number;
  fetchPolicy: SafeFetchPolicy;
  fetch?: FetchLike;
  now?: () => number;
}

/**
 * Claims one job for an agent, runs its role under the task bounds with a heartbeated lease,
 * and completes the job. A lost lease leaves reconciliation to control; the runner never
 * re-runs a job it no longer holds.
 */
export async function runOnce(cred: AgentCredential, o: WorkerOptions): Promise<{ jobId: string; outcome: RoleOutcome } | null> {
  const leaseMs = o.leaseMs ?? 60_000;
  const now = o.now ?? Date.now;
  const client = new ControlClient({ baseUrl: o.controlUrl, token: cred.token, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const claimed = await client.claim(o.workerId, leaseMs);
  if (claimed.status !== 200 || !claimed.body?.job) return null;
  const job = claimed.body.job as { id: string; version: string };
  const task = claimed.body.task;
  let version = job.version;
  let leaseLost = false;
  let inflight: Promise<void> = Promise.resolve();
  const beat = setInterval(() => {
    inflight = inflight.then(() =>
      client.heartbeat(job.id, o.workerId, version, leaseMs).then(
        (r) => {
          if (r.status === 200) version = r.body.job.version as string;
          else leaseLost = true;
        },
        () => undefined,
      ),
    );
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  beat.unref();

  const started = task?.startedAt ? Date.parse(task.startedAt) : now();
  const limits = task?.limits ?? {};
  const bounds: RunBounds = {
    maxToolCalls: Math.min(limits.maxToolCalls ?? TASK_RUN_BOUNDS.maxToolCalls, TASK_RUN_BOUNDS.maxToolCalls),
    maxPaidPurchases: Math.min(limits.maxPaidPurchases ?? TASK_RUN_BOUNDS.maxPaidPurchases, TASK_RUN_BOUNDS.maxPaidPurchases),
    maxPlanningCalls: Math.min(limits.maxPlanningCalls ?? TASK_RUN_BOUNDS.maxPlanningCalls, TASK_RUN_BOUNDS.maxPlanningCalls),
    deadlineMs: Math.min(started + (limits.maxDurationMs ?? TASK_RUN_BOUNDS.maxDurationMs), task?.deadline ? Date.parse(task.deadline) : Number.MAX_SAFE_INTEGER),
  };
  let outcome: RoleOutcome;
  try {
    if (!task) outcome = { taskState: "failed", summary: { error: "job has no task" } };
    else {
      const ctx = { client, taskId: task.id as string, agentId: cred.agentId, task, bounds, now, notes: [] as string[] };
      outcome = cred.role === "research" ? await runPrince(ctx, o.fetchPolicy) : await runMira(ctx);
    }
  } catch (error) {
    outcome = { taskState: "failed", summary: { error: `${(error as Error).name}: ${(error as Error).message}` } };
  } finally {
    clearInterval(beat);
  }
  await inflight;
  const summary = { ...outcome.summary, toolCalls: client.toolCalls, planningCalls: client.planningCalls, deniedTools: client.denied };
  if (!leaseLost) {
    await client.complete(job.id, {
      workerId: o.workerId,
      version,
      outcome: outcome.taskState === "failed" ? "failed" : "completed",
      taskState: outcome.taskState,
      result: summary,
    });
  }
  return { jobId: job.id, outcome: { ...outcome, summary } };
}

/** Polls each agent's queue until stopped. */
export function startWorker(creds: AgentCredential[], o: WorkerOptions, intervalMs = 3_000): () => void {
  let stopped = false;
  let busy = false;
  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    void (async () => {
      for (const c of creds) {
        try {
          await runOnce(c, o);
        } catch (error) {
          console.error(`[runner] ${c.role} worker error: ${(error as Error).name}`);
        }
      }
    })().finally(() => {
      busy = false;
    });
  }, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
