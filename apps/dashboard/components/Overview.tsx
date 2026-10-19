"use client";

import Link from "next/link";
import { useMemo } from "react";
import { api } from "../lib/api";
import { usdc } from "../lib/format";
import { ROLE_LABEL, agentStateLabel, taskStateLabel } from "../lib/labels";
import { summarizeResult } from "../lib/results";
import { dailySpend, treasuryParts, usedOf } from "../lib/spend";
import type { Activity, Agent, AgentBudget, Balances, Job, Task } from "../lib/types";
import { ActivityTable } from "./Activity";
import { AgentAvatar, WorkingAvatar } from "./Avatar";
import { AgentSpendBars, DailyBars, Meter, StackedBar, Stat } from "./Charts";
import { Icon } from "./Icon";
import { useCapability, useOwner } from "./Shell";
import { EmergencyStop } from "./StopControls";
import { TreasurySummary } from "./TreasurySummary";
import { useAction, useResource } from "./hooks";
import { DeniedHint, ErrorNotice, Loading, Section } from "./ui";

/** Payments the workspace page loads; the spending chart says so when this page may not reach back far enough. */
const ACTIVITY_LIMIT = 200;

const ACTIVE_TASK = new Set(["queued", "running"]);

/** One agent as a card: who it is, whether it can act, what it has left and how its last job went. */
export function AgentCard({ agent, budget, task, job, stopped }: { agent: Agent; budget: AgentBudget | undefined; task: Task | undefined; job: Job | undefined; stopped: boolean }) {
  const ok = agent.status === "active" && !stopped;
  const tone = ok ? "ok" : agent.status === "paused" || agent.status === "draft" ? "warn" : "danger";
  const working = ok && task !== undefined && ACTIVE_TASK.has(task.state);
  const last = working ? `${taskStateLabel(task.state)} · ${task.objective}` : job ? summarizeResult(job, task) : task ? task.objective : "No tasks yet";
  const lastState = working ? "running" : job ? (task && task.id === job.taskId ? task.state : job.state) : "none";
  const lastTone = lastState === "failed" ? "danger" : lastState === "completed" ? "ok" : lastState === "running" ? "accent" : lastState === "incomplete" ? "warn" : "muted";
  const life = budget?.lifetime;
  return (
    <li>
      <Link href={`/agents/${agent.id}`} className="agent-card">
        <span className="agent-card-head">
          {working ? <WorkingAvatar agent={agent} size={44} /> : <AgentAvatar agent={agent} size={44} />}
          <span className="agent-card-id">
            <span className="agent-card-name">{agent.name}</span>
            <span className="agent-card-role">{ROLE_LABEL[agent.role]}</span>
          </span>
          <span className={`pill pill-${tone}`}>{agentStateLabel(agent.status, stopped)}</span>
        </span>
        <span className="agent-card-budget">
          {life ? (
            <>
              <span className="agent-card-budget-line">
                <span>
                  <strong>{usdc(life.available)}</strong> left
                </span>
                <span className="muted">of {usdc(life.limit).replace(" USDC", "")}</span>
              </span>
              <Meter left={life.available} limit={life.limit} label={`${agent.name} budget left`} />
            </>
          ) : (
            <span className="muted">Budget unavailable</span>
          )}
        </span>
        <span className="agent-card-last" title={last}>
          <span className={`dot dot-${lastTone}`} aria-hidden="true" />
          <span className="agent-card-last-text">{last}</span>
        </span>
        <span className="agent-card-open">
          Open <Icon name="arrow-right" size={16} />
        </span>
      </Link>
    </li>
  );
}

export function Overview() {
  const { workspace, reloadWorkspace } = useOwner();
  const balances = useResource(() => api<Balances>("control", "/balances"), "balances");
  const tasks = useResource(() => api<{ tasks: Task[]; jobs: Job[] }>("control", "/tasks?limit=50"), "tasks");
  const activity = useResource(() => api<Activity>("control", `/activity?limit=${ACTIVITY_LIMIT}`), "activity");
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
  const ai = useResource(() => api<{ provider: { provider: string; model: string } | null }>("control", "/ai-provider"), "ai-provider");
  const aiModel = ai.data?.provider ?? null;
  const parts = b ? treasuryParts(b) : null;
  const series = useMemo(() => (activity.data ? dailySpend(activity.data.purchases, new Date(), 7, ACTIVITY_LIMIT) : null), [activity.data]);
  const byAgent = (b?.cash?.byAgent ?? [])
    .filter((c) => c.spent !== "0" || c.reserved !== "0")
    .sort((x, y) => (BigInt(y.spent) + BigInt(y.reserved) > BigInt(x.spent) + BigInt(x.reserved) ? 1 : -1));

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
            <strong>Agents can’t spend yet.</strong> Confirm the limits: {usdc(draftWs.lifetimeTestUsdc)} in total, {usdc(draftWs.rolling24hTestUsdc)} a day.
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
            Confirm limits
          </button>
          <DeniedHint reason={configure.reason} />
        </div>
      ) : null}
      <ErrorNotice error={activate.error} />
      {!activeWs && !draftWs ? <p className="notice notice-warn">No workspace spending limits are set, so no agent can spend.</p> : null}

      <div className="stats">
        <Stat label="Ready to spend" value={parts ? usdc(parts.ready) : "—"} sub={parts ? "In your private pool" : b ? "Hidden in the public view" : undefined} />
        <Stat label="Left today" value={wsBudget ? usdc(wsBudget.rolling24h.available) : "—"} sub={wsBudget ? `of ${usdc(wsBudget.rolling24h.limit)} · rolling 24 h` : "No active limit"}>
          {wsBudget ? <Meter left={wsBudget.rolling24h.available} limit={wsBudget.rolling24h.limit} label="Workspace limit left today" /> : null}
        </Stat>
        <Stat label="Spent" value={b?.cash ? usdc(b.cash.spent) : "—"} sub={b?.cash && b.cash.reserved !== "0" ? `${usdc(b.cash.reserved)} held` : wsBudget ? `${usdc(usedOf(wsBudget.lifetime))} of ${usdc(wsBudget.lifetime.limit)} cap used` : undefined} />
        <Stat label="AI model" value={ai.data ? (aiModel ? aiModel.model : "Trial") : "—"} sub={ai.data ? (aiModel ? "Your own key" : "Add your key in Settings") : undefined} />
      </div>
      {ai.data && !aiModel && configure.allowed ? (
        <div className="notice notice-row" role="status">
          <span>
            <strong>Add your AI key</strong> so agents run on your own model.
          </span>
          <Link className="btn btn-small btn-primary" href="/settings">
            Add key
          </Link>
        </div>
      ) : null}
      <ErrorNotice error={balances.error} what="balances" onRetry={balances.reload} />

      <div className="viz-grid">
        <section className="panel viz-card viz-wide" aria-labelledby="viz-spend">
          <div className="viz-head">
            <h2 id="viz-spend">Spending</h2>
            <span className="viz-sub">Paid on chain · last 7 days</span>
          </div>
          {series ? (
            <>
              <DailyBars days={series.days} limit={wsBudget ? wsBudget.rolling24h.limit : null} />
              <p className="hint flush">Bars show calendar days. The limit applies to the previous 24 hours, including held funds.</p>
              {series.complete ? null : <p className="hint flush">Only the latest {ACTIVITY_LIMIT} payments are loaded; earlier days may be missing some.</p>}
            </>
          ) : activity.error ? null : (
            <Loading label="payments" />
          )}
        </section>

        <section className="panel viz-card" aria-labelledby="viz-treasury">
          <div className="viz-head">
            <h2 id="viz-treasury">Treasury</h2>
            <Link className="viz-link" href="/wallet">
              Wallet
            </Link>
          </div>
          {parts ? (
            <>
              <StackedBar
                label="Your pool funds"
                segments={[
                  { key: "ready", label: "Ready to spend", value: parts.ready, slot: 1 },
                  { key: "held", label: "Held for purchases", value: parts.held, slot: 2 },
                  { key: "pending", label: "On the way", value: parts.pending, slot: 3 },
                ]}
              />
              {parts.outside !== "0" ? <p className="hint flush">{usdc(parts.outside)} sits in one-time payment wallets, outside the pool.</p> : null}
            </>
          ) : b ? (
            <p className="muted flush">Hidden in the public view.</p>
          ) : balances.error ? null : (
            <Loading label="balances" />
          )}
        </section>

        <section className="panel viz-card" aria-labelledby="viz-agents">
          <div className="viz-head">
            <h2 id="viz-agents">By agent</h2>
            <span className="viz-sub">USDC paid</span>
          </div>
          {b ? (
            byAgent.length > 0 ? (
              <AgentSpendBars
                rows={byAgent.map((c) => {
                  const agent = workspace.agents.find((a) => a.id === c.agentId);
                  return {
                    id: c.agentId,
                    name: agent?.name ?? c.name,
                    avatar: agent ? <AgentAvatar agent={agent} size={24} /> : <span className="hbars-avatar-gap" />,
                    spent: c.spent,
                    held: c.reserved,
                  };
                })}
              />
            ) : (
              <p className="muted flush">No agent has paid for anything yet.</p>
            )
          ) : balances.error ? null : (
            <Loading label="balances" />
          )}
        </section>
      </div>

      <section className="agents-block" aria-labelledby="agents-title">
        <div className="block-head">
          <h2 id="agents-title">
            Agents <span className="count">{visibleAgents.length}</span>
          </h2>
        </div>
        {visibleAgents.length === 0 ? (
          <div className="panel empty-card">
            <p className="flush">No agents yet.</p>
            {create.allowed ? (
              <Link className="btn btn-primary" href="/agents/new">
                Create agent
              </Link>
            ) : null}
          </div>
        ) : (
          <ul className="agent-grid">
            {visibleAgents.map((a) => (
              <AgentCard
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
        {archived.length > 0 ? (
          <details className="archived">
            <summary>Archived ({archived.length})</summary>
            <ul className="archived-list">
              {archived.map((a) => (
                <li key={a.id}>
                  <Link href={`/agents/${a.id}`}>
                    <AgentAvatar agent={a} size={24} />
                    {a.name}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="hint flush">Stopped. Their records are kept.</p>
          </details>
        ) : null}
        <ErrorNotice error={tasks.error} what="tasks" onRetry={tasks.reload} />
      </section>

      <Section
        title="Recent payments"
        actions={
          <Link className="btn btn-small" href="/wallet">
            View all
          </Link>
        }
      >
        {activity.data ? <ActivityTable activity={activity.data} workspace={workspace} onChanged={reloadAll} limit={8} /> : activity.error ? null : <Loading label="activity" />}
        <ErrorNotice error={activity.error} what="activity" onRetry={activity.reload} />
      </Section>

      <details className="panel disclosure">
        <summary>Limits per agent</summary>
        {b ? <TreasurySummary balances={b} agents={workspace.agents} /> : balances.error ? null : <Loading label="balances" />}
      </details>

      <Section title="Emergency stop">
        <EmergencyStop stopped={ws.stopped} onChanged={reloadAll} />
      </Section>
    </>
  );
}
