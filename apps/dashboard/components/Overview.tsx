"use client";

import Link from "next/link";
import { api } from "../lib/api";
import type { Activity, Balances, Job, Task } from "../lib/types";
import { ActivityList } from "./Activity";
import { AgentCard } from "./AgentCard";
import { useOwner } from "./Shell";
import { EmergencyStop } from "./StopControls";
import { TreasurySummary } from "./TreasurySummary";
import { useAction, useResource } from "./hooks";
import { ErrorNotice, KV, Loading, Section } from "./ui";
import { lamports, usdc } from "../lib/format";

export function Overview() {
  const { workspace, reloadWorkspace } = useOwner();
  const balances = useResource(() => api<Balances>("control", "/balances"), "balances");
  const tasks = useResource(() => api<{ tasks: Task[]; jobs: Job[] }>("control", "/tasks?limit=50"), "tasks");
  const activity = useResource(() => api<Activity>("control", "/activity?limit=50"), "activity");
  const activate = useAction();
  const reloadAll = async () => {
    await Promise.all([reloadWorkspace(), balances.reload(), tasks.reload(), activity.reload()]);
  };
  const ws = workspace.workspace;
  const activeWs = workspace.policies.find((p) => p.scope === "workspace" && p.status === "active");
  const draftWs = workspace.policies.filter((p) => p.scope === "workspace" && p.status === "draft").at(-1);
  const visibleAgents = workspace.agents.filter((a) => a.status !== "archived");
  const archived = workspace.agents.filter((a) => a.status === "archived");

  return (
    <>
      <h1>Workspace overview</h1>
      {draftWs ? (
        <Section title={`Workspace policy v${draftWs.version} awaits activation`}>
          <KV
            rows={[
              ["Tier", draftWs.tier.replace(/_/g, " ")],
              ["Workspace lifetime allocation", usdc(draftWs.lifetimeTestUsdc)],
              ["Workspace rolling 24 h cap", usdc(draftWs.rolling24hTestUsdc)],
              ["SOL sponsor allowance", lamports(draftWs.sponsorLamportLimit)],
            ]}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={activate.busy}
            onClick={() =>
              void activate.run(async () => {
                await api("control", "/workspace/policy", { method: "POST", body: { activateVersion: draftWs.version } });
                await reloadAll();
              })
            }
          >
            Activate workspace policy v{draftWs.version}
          </button>
          <ErrorNotice error={activate.error} />
        </Section>
      ) : null}
      {!activeWs && !draftWs ? <p className="notice notice-warn">No workspace policy exists; no agent can spend.</p> : null}

      <Section
        title="Agents"
        actions={
          <Link className="btn" href="/agents/new">
            Create agent
          </Link>
        }
      >
        <div className="cards">
          {visibleAgents.map((a) => {
            const agentTasks = tasks.data?.tasks.filter((t) => t.agentId === a.id) ?? [];
            const agentJobs = tasks.data?.jobs.filter((j) => j.agentId === a.id && (j.state === "completed" || j.state === "failed")) ?? [];
            return (
              <AgentCard
                key={a.id}
                agent={a}
                budget={balances.data?.agents.find((b) => b.agentId === a.id)}
                balances={balances.data}
                task={agentTasks[0]}
                job={agentJobs[0]}
                workspaceStopped={ws.stopped}
                onChanged={reloadAll}
              />
            );
          })}
        </div>
        {archived.length > 0 ? <p className="small muted">Archived (records kept): {archived.map((a) => a.name).join(", ")}</p> : null}
        <ErrorNotice error={tasks.error} what="tasks" onRetry={tasks.reload} />
      </Section>

      <Section title="Emergency stop">
        <EmergencyStop stopped={ws.stopped} onChanged={reloadAll} />
      </Section>

      {balances.data ? <TreasurySummary balances={balances.data} agents={workspace.agents} /> : balances.error ? null : <Loading label="balances" />}
      <ErrorNotice error={balances.error} what="balances" onRetry={balances.reload} />

      <Section
        title="Recent payments"
        actions={
          <Link className="btn" href="/activity">
            All activity
          </Link>
        }
      >
        {activity.data ? <ActivityList activity={activity.data} workspace={workspace} onChanged={reloadAll} limit={6} /> : <Loading label="activity" />}
        <ErrorNotice error={activity.error} what="activity" onRetry={activity.reload} />
      </Section>
    </>
  );
}
