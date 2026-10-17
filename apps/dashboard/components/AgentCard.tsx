"use client";

import Link from "next/link";
import { api } from "../lib/api";
import { credits, usdc, when } from "../lib/format";
import { ROLE_LABEL, agentStateLabel, runBlockedReason } from "../lib/labels";
import type { Agent, AgentBudget, Balances, Job, Task } from "../lib/types";
import { AgentControls } from "./AgentControls";
import { useAction } from "./hooks";
import { ErrorNotice } from "./ui";

/** Summarizes a finished job; a task's own state wins over the job's lease outcome. */
export function summarizeResult(job: Job | undefined, task?: Task): string {
  if (!job) return "No result yet";
  const r = job.result ?? {};
  if (typeof r.detail === "string") return `${String(r.decision ?? job.state)}: ${r.detail}`;
  if (typeof r.error === "string") return `${job.state}: ${r.error}`;
  const parts = [task && task.id === job.taskId ? `Task ${task.state}` : `${job.kind.replace(/_/g, " ")} ${job.state}`];
  if (Array.isArray(r.paid)) {
    for (const p of r.paid as Array<{ sku?: unknown; outcome?: unknown }>) {
      if (typeof p.sku === "string" && typeof p.outcome === "string") parts.push(`${p.sku}: ${p.outcome}`);
    }
  }
  const hire = r.hire as { proposalId?: unknown; code?: unknown } | null | undefined;
  if (hire && typeof hire === "object") {
    parts.push(typeof hire.proposalId === "string" ? "hire proposed (unpaid until you approve it or it matches a pre-approved listing)" : `hire refused (${String(hire.code)})`);
  }
  if (typeof r.artifactId === "string") parts.push("result saved to Content");
  return parts.join(" · ");
}

export function AgentCard({
  agent,
  budget,
  balances,
  task,
  job,
  workspaceStopped,
  onChanged,
}: {
  agent: Agent;
  budget: AgentBudget | undefined;
  balances: Balances | undefined;
  task: Task | undefined;
  job: Job | undefined;
  workspaceStopped: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const run = useAction();
  const cash = balances?.cash?.byAgent.find((c) => c.agentId === agent.id);
  const usage = balances?.usageByAgent?.find((u) => u.agentId === agent.id);
  const canRun = agent.status === "active" && !workspaceStopped;
  const headingId = `agent-${agent.id}`;
  return (
    <article className={`card card-${agent.role}`} aria-labelledby={headingId}>
      <header className="card-head">
        <h3 id={headingId}>
          <Link href={`/agents/${agent.id}`}>{agent.name}</Link>
        </h3>
        <span className={`pill pill-${agent.status === "active" && !workspaceStopped ? "ok" : agent.status === "paused" ? "warn" : "danger"}`}>
          {agentStateLabel(agent.status, workspaceStopped)}
        </span>
      </header>
      <p className="role">{ROLE_LABEL[agent.role]}</p>
      <dl className="kv compact">
        <div className="kv-row">
          <dt>Allowance</dt>
          <dd>{budget?.lifetime ? `${usdc(budget.lifetime.available)} of ${usdc(budget.lifetime.limit)} remaining` : "Policy not activated"}</dd>
        </div>
        <div className="kv-row">
          <dt>Pending spend</dt>
          <dd>{cash ? usdc(cash.reserved) : "—"}</dd>
        </div>
        <div className="kv-row">
          <dt>Credit usage</dt>
          <dd>
            {usage ? `${credits(usage.consumedUnits)} consumed` : "—"}
            {budget?.usageAllowance && budget.usageAllowance.limit !== "0" ? ` · ${credits(budget.usageAllowance.available)} allowance left` : ""}
          </dd>
        </div>
        <div className="kv-row">
          <dt>Recent task</dt>
          <dd>{task ? `${task.objective} (${task.state}, ${when(task.createdAt)})` : agent.role === "credit_manager" ? "Threshold checks" : "None yet"}</dd>
        </div>
        <div className="kv-row">
          <dt>Last result</dt>
          <dd>{summarizeResult(job, task)}</dd>
        </div>
      </dl>
      <div className="actions">
        <Link className="btn" href={`/agents/${agent.id}#settings`}>
          Configure {agent.name}
        </Link>
        {agent.role === "credit_manager" ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canRun || run.busy}
            onClick={() =>
              void run.run(async () => {
                await api("control", `/agents/${agent.id}/run`, { method: "POST", body: {} });
                await onChanged();
              })
            }
          >
            Check now
          </button>
        ) : canRun ? (
          <Link className="btn btn-primary" href={`/agents/${agent.id}#run`}>
            Run {agent.name}
          </Link>
        ) : (
          <button type="button" className="btn btn-primary" disabled>
            Run {agent.name}
          </button>
        )}
      </div>
      {runBlockedReason(agent.status, workspaceStopped) ? <p className="small muted">{runBlockedReason(agent.status, workspaceStopped)}</p> : null}
      <ErrorNotice error={run.error} what="run" />
      <AgentControls agent={agent} onChanged={onChanged} />
    </article>
  );
}
