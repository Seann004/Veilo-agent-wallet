import { SPONSORED_PLANNING_LABEL } from "@veilo/contracts/gateway";
import { immediate } from "@veilo/db";
import { iso, num, optIso, type Ledger } from "../context";
import { ControlError } from "../errors";
import { GatewayUnreachableError, type GatewayClient } from "../integration/gateway-client";
import { writeAudit } from "../ledger/events";
import { claimNextJob, completeJob, getJob, heartbeatJob, jobView } from "../ledger/jobs";
import type { AgentRow } from "../ledger/workspace";

export interface TaskRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  objective: string;
  input_json: string;
  limit_usdc: bigint;
  usage_limit_units: bigint;
  deadline_at_ms: bigint | null;
  max_tool_calls: bigint;
  tool_calls: bigint;
  max_purchases: bigint;
  purchase_count: bigint;
  max_planning_calls: bigint;
  planning_calls: bigint;
  state: string;
  started_at_ms: bigint | null;
  max_duration_ms: bigint;
  created_at_ms: bigint;
}

export function getTask(ledger: Ledger, taskId: string): TaskRow | undefined {
  return ledger.db.prepare(`SELECT * FROM task WHERE id = ?`).get(taskId) as TaskRow | undefined;
}

export function ownTask(ledger: Ledger, agentId: string, taskId: string): TaskRow {
  const t = getTask(ledger, taskId);
  if (!t || t.agent_id !== agentId) throw new ControlError("POLICY_DENIED", "task scope mismatch");
  return t;
}

export function taskView(t: TaskRow): Record<string, unknown> {
  const input = JSON.parse(t.input_json) as Record<string, unknown>;
  return {
    id: t.id,
    agentId: t.agent_id,
    objective: t.objective,
    input,
    hasReferenceImage: input.hasReferenceImage === true,
    state: t.state,
    deadline: optIso(t.deadline_at_ms),
    startedAt: optIso(t.started_at_ms),
    limits: {
      taskUsdc: t.limit_usdc.toString(),
      taskUsageUnits: t.usage_limit_units.toString(),
      maxToolCalls: num(t.max_tool_calls),
      maxPaidPurchases: num(t.max_purchases),
      maxPlanningCalls: num(t.max_planning_calls),
      maxDurationMs: num(t.max_duration_ms),
    },
    used: { toolCalls: num(t.tool_calls), paidPurchases: num(t.purchase_count), planningCalls: num(t.planning_calls) },
    createdAt: iso(t.created_at_ms),
  };
}

/** Rejects work on a task that is not running or has exceeded its deadline or duration bound. */
export function assertTaskLive(ledger: Ledger, t: TaskRow): void {
  if (t.state !== "running") throw new ControlError("POLICY_DENIED", `task is ${t.state}`);
  const now = ledger.now();
  if (t.deadline_at_ms !== null && now > num(t.deadline_at_ms)) throw new ControlError("POLICY_DENIED", "task deadline has passed");
  if (t.started_at_ms !== null && now > num(t.started_at_ms) + num(t.max_duration_ms)) {
    throw new ControlError("BUDGET_EXCEEDED", "task duration bound reached");
  }
}

/** Counts one agent tool call against the task; the table CHECK makes the bound absolute. */
export function chargeToolCall(ledger: Ledger, agentId: string, taskId: string, tool: string): void {
  immediate(ledger.db, () => {
    const t = ownTask(ledger, agentId, taskId);
    assertTaskLive(ledger, t);
    if (t.tool_calls >= t.max_tool_calls) {
      writeAudit(ledger, {
        workspaceId: t.workspace_id,
        scope: `agent:${agentId}`,
        actorType: "worker",
        actorId: agentId,
        action: "task.tool_call",
        policyResult: "denied",
        reasonCode: "BUDGET_EXCEEDED",
        details: { taskId, tool },
      });
      throw new ControlError("BUDGET_EXCEEDED", "task tool-call limit reached");
    }
    ledger.db.prepare(`UPDATE task SET tool_calls = tool_calls + 1, updated_at_ms = ? WHERE id = ?`).run(ledger.now(), taskId);
  });
}

/** Runner job claim for research/content agents; credit checks run inside the control scheduler. */
export function claimWorkerJob(ledger: Ledger, agent: AgentRow, workerId: string, leaseMs: number): Record<string, unknown> | null {
  if (agent.role === "credit_manager") throw new ControlError("FORBIDDEN", "credit checks run in the control scheduler");
  const job = claimNextJob(ledger, `${workerId}:${agent.id}`, leaseMs, agent.id);
  if (!job) return null;
  if (job.task_id) {
    ledger.db
      .prepare(`UPDATE task SET state = 'running', started_at_ms = ifnull(started_at_ms, ?), updated_at_ms = ? WHERE id = ? AND state = 'queued'`)
      .run(ledger.now(), ledger.now(), job.task_id);
  }
  const task = job.task_id ? getTask(ledger, job.task_id) : undefined;
  return { job: { ...jobView(job), version: job.version.toString() }, task: task ? taskView(task) : null };
}

function ownJob(ledger: Ledger, agent: AgentRow, jobId: string) {
  const job = getJob(ledger, jobId);
  if (job.agent_id !== agent.id) throw new ControlError("POLICY_DENIED", "job scope mismatch");
  return job;
}

export function heartbeatWorkerJob(ledger: Ledger, agent: AgentRow, jobId: string, workerId: string, version: string, leaseMs: number): Record<string, unknown> {
  ownJob(ledger, agent, jobId);
  const job = heartbeatJob(ledger, jobId, `${workerId}:${agent.id}`, BigInt(version), leaseMs);
  return { job: { ...jobView(job), version: job.version.toString() } };
}

export function completeWorkerJob(
  ledger: Ledger,
  agent: AgentRow,
  jobId: string,
  body: { workerId: string; version: string; outcome: "completed" | "failed"; taskState?: "completed" | "incomplete" | "failed" | undefined; result: Record<string, unknown> },
): Record<string, unknown> {
  ownJob(ledger, agent, jobId);
  return immediate(ledger.db, () => {
    const job = completeJob(ledger, jobId, `${body.workerId}:${agent.id}`, BigInt(body.version), body.outcome, body.result);
    if (job.task_id) {
      const state = body.taskState ?? (body.outcome === "completed" ? "completed" : "failed");
      ledger.db.prepare(`UPDATE task SET state = ?, updated_at_ms = ? WHERE id = ? AND state = 'running'`).run(state, ledger.now(), job.task_id);
    }
    return { job: { ...jobView(job), version: job.version.toString() } };
  });
}

/**
 * Operator-sponsored planning on behalf of a running task. The call slot is consumed before
 * the request whatever the outcome, so a failure is never retried silently past the bound.
 */
export async function sponsoredPlanning(
  ledger: Ledger,
  gateway: GatewayClient | undefined,
  agent: AgentRow,
  body: { taskId: string; purpose: string; messages: Array<{ role: "system" | "user"; content: string }>; maxOutputTokens?: number | undefined },
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!gateway?.planningConfigured) throw new ControlError("NOT_READY", "sponsored planning is not configured");
  const callIndex = immediate(ledger.db, () => {
    const t = ownTask(ledger, agent.id, body.taskId);
    assertTaskLive(ledger, t);
    if (t.planning_calls >= t.max_planning_calls) throw new ControlError("BUDGET_EXCEEDED", "task planning-call limit reached");
    ledger.db.prepare(`UPDATE task SET planning_calls = planning_calls + 1, updated_at_ms = ? WHERE id = ?`).run(ledger.now(), t.id);
    writeAudit(ledger, {
      workspaceId: t.workspace_id,
      scope: `agent:${agent.id}`,
      actorType: "worker",
      actorId: agent.id,
      action: "planning.sponsored",
      policyResult: "allowed",
      details: { taskId: t.id, callIndex: num(t.planning_calls) + 1, purpose: body.purpose },
    });
    return num(t.planning_calls) + 1;
  });
  try {
    const r = await gateway.planning({
      taskRef: body.taskId,
      purpose: body.purpose,
      messages: body.messages,
      ...(body.maxOutputTokens !== undefined ? { maxOutputTokens: body.maxOutputTokens } : {}),
    });
    return { status: r.status, body: { label: SPONSORED_PLANNING_LABEL, callIndex, gateway: r.body ?? null } };
  } catch (error) {
    if (error instanceof GatewayUnreachableError) {
      return { status: 503, body: { label: SPONSORED_PLANNING_LABEL, callIndex, gateway: { outcome: { status: "uncertain", message: error.message } } } };
    }
    throw error;
  }
}

/** Citation URL for a successful connector call; research briefs may cite only calls of their own task. */
export function connectorCitation(connectorId: string, tool: string, callId: string): string {
  return `mcp:${connectorId}/${tool}#call=${callId}`;
}

const URL_PATTERN = /\b(?:https?|fixture):\/\/[^\s)\]>"']+/g;

/**
 * Research briefs may cite only evidence delivered by this agent's purchased datasets, and
 * may mention no other URL except owner-supplied sources from the task input.
 */
export function validateResearchCitations(
  ledger: Ledger,
  agentId: string,
  a: { taskId: string; content: string; citations: Array<{ url: string }>; sourcePurchaseIds: string[] },
): void {
  const evidence = new Set<string>();
  for (const pid of a.sourcePurchaseIds) {
    const row = ledger.db
      .prepare(
        `SELECT p.agent_id, p.fulfilment_state, e.result_json FROM purchase p LEFT JOIN purchase_execution e ON e.purchase_id = p.id WHERE p.id = ?`,
      )
      .get(pid) as { agent_id: string; fulfilment_state: string; result_json: string | null } | undefined;
    if (!row || row.agent_id !== agentId) throw new ControlError("POLICY_DENIED", "source purchase scope mismatch");
    if (row.fulfilment_state !== "delivered" || !row.result_json) continue;
    const result = JSON.parse(row.result_json) as { records?: Array<{ source?: { url?: string } }> };
    for (const r of result.records ?? []) if (typeof r.source?.url === "string") evidence.add(r.source.url);
  }
  // Free connector output is citable only from this task's own successful calls.
  const calls = ledger.db
    .prepare(`SELECT id, connector_id, tool FROM agent_connector_call WHERE agent_id = ? AND task_id = ? AND outcome = 'ok'`)
    .all(agentId, a.taskId) as Array<{ id: string; connector_id: string; tool: string }>;
  for (const c of calls) evidence.add(connectorCitation(c.connector_id, c.tool, c.id));
  // Pages control authorized this task to read are citable; any other link is not.
  for (const url of ledger.db.prepare(`SELECT url FROM browse_page WHERE task_id = ?`).pluck().all(a.taskId) as string[]) evidence.add(url);
  for (const c of a.citations) {
    if (!evidence.has(c.url)) throw new ControlError("POLICY_DENIED", "citation does not map to purchased evidence, a connector call or a permitted page of this task");
  }
  const task = ownTask(ledger, agentId, a.taskId);
  const ownerSources = new Set<string>(((JSON.parse(task.input_json) as { sources?: string[] }).sources ?? []).map(String));
  for (const url of a.content.match(URL_PATTERN) ?? []) {
    if (!evidence.has(url) && !ownerSources.has(url)) throw new ControlError("POLICY_DENIED", "brief references a URL that is not purchased evidence");
  }
}
