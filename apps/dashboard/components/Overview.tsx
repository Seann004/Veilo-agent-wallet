"use client";

import Link from "next/link";
import { api } from "../lib/api";
import { credits, usdc } from "../lib/format";
import { ROLE_LABEL, agentStateLabel } from "../lib/labels";
import { summarizeResult } from "../lib/results";
import type { Activity, Agent, AgentBudget, Balances, Job, Task } from "../lib/types";
import { ActivityList } from "./Activity";
import { AgentAvatar } from "./Avatar";
import { useCapability, useOwner } from "./Shell";
import { EmergencyStop } from "./StopControls";
import { TreasurySummary } from "./TreasurySummary";
import { useAction, useResource } from "./hooks";
import { DeniedHint, ErrorNotice, Loading, Section } from "./ui";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

export function AgentRow({ agent, budget, task, job, stopped }: { agent: Agent; budget: AgentBudget | undefined; task: Task | undefined; job: Job | undefined; stopped: boolean }) {
  const ok = agent.status === "active" && !stopped;
  const tone = ok ? "ok" : agent.status === "paused" || agent.status === "draft" ? "warn" : "danger";
  const sub = job ? summarizeResult(job, task) : task ? task.objective : "No tasks yet";
  return (
    <li>
      <Link href={`/agents/${agent.id}`} className="agent-row">
        <AgentAvatar agent={agent} size={40} />
        <span className="agent-row-text">
          <span className="agent-row-name">
            {agent.name} <span className="muted">· {ROLE_LABEL[agent.role]}</span>
          </span>
          <span className="agent-row-sub" title={sub}>
            {sub}
          </span>
        </span>
        <span className="agent-row-budget">
          {budget?.lifetime ? (
            <>
              <strong>{usdc(budget.lifetime.available)}</strong>
              <span className="muted"> left</span>
            </>
          ) : (
            <span className="muted">No active policy</span>
          )}
        </span>
        <span className={`pill pill-${tone}`}>{agentStateLabel(agent.status, stopped)}</span>
      </Link>
    </li>
  );
}

export function Overview() {
  const { workspace, reloadWorkspace } = useOwner();
  const balances = useResource(() => api<Balances>("control", "/balances"), "balances");
  const tasks = useResource(() => api<{ tasks: Task[]; jobs: Job[] }>("control", "/tasks?limit=50"), "tasks");
  const activity = useResource(() => api<Activity>("control", "/activity?limit=50"), "activity");
  const activate = useAction();
  const configure = useCapability("configure");
  const create = useCapability("create");
  const reloadAll = async () => {
    await Promise.all([reloadWorkspace(), balances.reload(), tasks.reload(), activity.reload()]);
  };
  const ws = workspace.workspace;
  const activeWs = workspace.policies.find((p) => p.scope === "workspace" && p.status === "active");
  const draftWs = workspace.policies.filter((p) => p.scope === "workspace" && p.status === "draft").at(-1);
  const visibleAgents = workspace.agents.filter((a) => a.status !== "archived");
  const archived = workspace.agents.filter((a) => a.status === "archived");
  const b = balances.data;
  const wsBudget = b && b.workspace.policyVersion !== null ? b.workspace : null;
  const gc = b?.gatewayCredits;

  return (
    <>
      <div className="page-head">
        <h1>Workspace</h1>
        {create.allowed ? (
          <Link className="btn btn-primary" href="/agents/new">
            Create agent
          </Link>
        ) : null}
      </div>

      {draftWs ? (
        <div className="notice notice-warn notice-row" role="status">
          <span>
            Workspace policy v{draftWs.version} is a draft: {usdc(draftWs.lifetimeTestUsdc)} lifetime, {usdc(draftWs.rolling24hTestUsdc)} per 24 h. No agent can spend until you activate it.
          </span>
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={activate.busy || !configure.allowed}
            title={configure.reason ?? undefined}
            onClick={() =>
              void activate.run(async () => {
                await api("control", "/workspace/policy", { method: "POST", body: { activateVersion: draftWs.version } });
                await reloadAll();
              })
            }
          >
            Activate workspace policy v{draftWs.version}
          </button>
          <DeniedHint reason={configure.reason} />
        </div>
      ) : null}
      <ErrorNotice error={activate.error} />
      {!activeWs && !draftWs ? <p className="notice notice-warn">No workspace policy exists; no agent can spend.</p> : null}

      <div className="stats">
        <Stat label="Spendable in pool" value={b?.tokens.buckets ? usdc(b.tokens.buckets.approved_unreserved ?? "0") : "—"} sub="Approved, unreserved notes" />
        <Stat label="Left today" value={wsBudget ? usdc(wsBudget.rolling24h.available) : "—"} sub={wsBudget ? `of ${usdc(wsBudget.rolling24h.limit)} per 24 h` : "No active workspace policy"} />
        <Stat label="Cash spent" value={b?.cash ? usdc(b.cash.spent) : "—"} sub={b?.cash ? `${usdc(b.cash.reserved)} reserved` : undefined} />
        <Stat label="Prepaid credits" value={gc ? (gc.available ? credits(gc.usable) : "Not ready") : "—"} sub="Demo, operator-funded" />
      </div>
      <ErrorNotice error={balances.error} what="balances" onRetry={balances.reload} />

      <Section title="Agents">
        {visibleAgents.length === 0 ? (
          <p className="muted flush">
            No agents yet.{create.allowed ? (
              <>
                {" "}
                <Link href="/agents/new">Create one</Link>.
              </>
            ) : null}
          </p>
        ) : (
          <ul className="agent-rows">
            {visibleAgents.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                budget={b?.agents.find((x) => x.agentId === a.id)}
                task={tasks.data?.tasks.find((t) => t.agentId === a.id)}
                job={tasks.data?.jobs.find((j) => j.agentId === a.id && (j.state === "completed" || j.state === "failed"))}
                stopped={ws.stopped}
              />
            ))}
          </ul>
        )}
        {archived.length > 0 ? <p className="small muted section-foot">Archived (records kept): {archived.map((a) => a.name).join(", ")}</p> : null}
        <ErrorNotice error={tasks.error} what="tasks" onRetry={tasks.reload} />
      </Section>

      <Section
        title="Recent payments"
        actions={
          <Link className="btn btn-small" href="/activity">
            View all
          </Link>
        }
      >
        {activity.data ? <ActivityList activity={activity.data} workspace={workspace} onChanged={reloadAll} limit={5} /> : <Loading label="activity" />}
        <ErrorNotice error={activity.error} what="activity" onRetry={activity.reload} />
      </Section>

      <details className="panel disclosure">
        <summary>Limits and treasury</summary>
        {b ? <TreasurySummary balances={b} agents={workspace.agents} /> : balances.error ? null : <Loading label="balances" />}
      </details>

      <Section title="Emergency stop">
        <EmergencyStop stopped={ws.stopped} onChanged={reloadAll} />
      </Section>
    </>
  );
}
