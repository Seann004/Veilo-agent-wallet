"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { api } from "../lib/api";
import { credits, parseUsdcInput, usdc, when } from "../lib/format";
import { ROLE_LABEL, agentStateLabel } from "../lib/labels";
import type { Activity, Agent, Balances, ContentItem, Handoff, Job, Task } from "../lib/types";
import { ActivityList } from "./Activity";
import { summarizeResult } from "./AgentCard";
import { AgentControls } from "./AgentControls";
import { PolicyForm, PolicyReview, type AgentPolicyInput } from "./Policy";
import { useOwner } from "./Shell";
import { useAction, useResource } from "./hooks";
import { ErrorNotice, KV, Loading, Section } from "./ui";

function policyInputOf(agent: Agent): AgentPolicyInput | null {
  const p = agent.activePolicy;
  if (!p) return null;
  return {
    tier: p.tier as AgentPolicyInput["tier"],
    lifetimeTestUsdc: p.lifetimeTestUsdc ?? "0",
    rolling24hTestUsdc: p.rolling24hTestUsdc ?? "0",
    maxPurchaseTestUsdc: p.maxPurchaseTestUsdc ?? "0",
    taskLimitTestUsdc: p.taskLimitTestUsdc ?? "0",
    usageAllowanceUnits: p.usageAllowanceUnits ?? "0",
    taskCreditUnits: p.taskCreditUnits ?? "0",
    allowedSkus: p.permissions?.allowedSkus ?? [],
    allowedPaymentPaths: (p.permissions?.allowedPaymentPaths ?? []) as AgentPolicyInput["allowedPaymentPaths"],
    ...(p.roleConfig && Object.keys(p.roleConfig).length > 0 ? { roleConfig: p.roleConfig as NonNullable<AgentPolicyInput["roleConfig"]> } : {}),
  };
}

function TextField({ label, value, onChange, required, type = "text", hint }: { label: string; value: string; onChange: (v: string) => void; required?: boolean; type?: string; hint?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input id={id} type={type} value={value} required={required} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-h` : undefined} />
      {hint ? (
        <span id={`${id}-h`} className="hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

const toIso = (local: string): string | undefined => {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().replace(/\.\d{3}Z$/, ".000Z");
};

/** Prince: research question, optional sources and deadline. Queues a task; the runner executes it. */
export function ResearchForm({ agent, disabled, onQueued }: { agent: Agent; disabled: boolean; onQueued: () => void | Promise<void> }) {
  const [question, setQuestion] = useState("");
  const [sources, setSources] = useState("");
  const [deadline, setDeadline] = useState("");
  const [budget, setBudget] = useState("");
  const action = useAction();
  const [queued, setQueued] = useState<string | null>(null);
  const qid = useId();
  const sid = useId();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          const list = sources
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean);
          const limit = budget ? parseUsdcInput(budget) : null;
          const r = await api<{ taskId: string; executor: string }>("control", `/agents/${agent.id}/run`, {
            method: "POST",
            body: {
              objective: question,
              input: { sources: list, ...(toIso(deadline) ? { deadline: toIso(deadline) } : {}) },
              ...(toIso(deadline) ? { deadline: toIso(deadline) } : {}),
              ...(limit ? { taskLimitTestUsdc: limit } : {}),
            },
          });
          setQueued(`Task ${r.taskId} ${r.executor}.`);
          await onQueued();
        });
      }}
    >
      <div className="field">
        <label htmlFor={qid}>Research question *</label>
        <textarea id={qid} required rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={sid}>Optional sources (URLs, one per line)</label>
        <textarea id={sid} rows={2} value={sources} onChange={(e) => setSources(e.target.value)} aria-describedby={`${sid}-h`} />
        <span id={`${sid}-h`} className="hint">
          Only approved services are purchased; suggested sources are untrusted input.
        </span>
      </div>
      <div className="grid-2">
        <TextField label="Deadline" type="datetime-local" value={deadline} onChange={setDeadline} />
        <TextField label="Task budget (test-USDC, optional)" value={budget} onChange={setBudget} hint="Defaults to the policy's per-task budget." />
      </div>
      <button type="submit" className="btn btn-primary" disabled={disabled || action.busy || question.trim() === ""}>
        Start research task
      </button>
      {queued ? (
        <p role="status" className="notice">
          {queued}
        </p>
      ) : null}
      <ErrorNotice error={action.error} />
    </form>
  );
}

/** Mira: campaign brief, optionally attached to an owner-approved handoff. */
export function CampaignForm({ agent, disabled, handoffs, onQueued }: { agent: Agent; disabled: boolean; handoffs: Handoff[]; onQueued: () => void | Promise<void> }) {
  const [f, setF] = useState({ topic: "", audience: "", c1: "", c2: "", c3: "", voice: "", deliverables: "Three channel drafts and a seven-day content calendar", deadline: "", startDate: "", handoffId: "" });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const action = useAction();
  const [queued, setQueued] = useState<string | null>(null);
  const hid = useId();
  const approved = handoffs.filter((h) => h.toAgentId === agent.id && h.state === "approved");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          const r = await api<{ taskId: string; executor: string }>("control", `/agents/${agent.id}/run`, {
            method: "POST",
            body: {
              input: {
                topic: f.topic,
                audience: f.audience,
                channels: [f.c1, f.c2, f.c3],
                voice: f.voice,
                deliverables: f.deliverables,
                ...(toIso(f.deadline) ? { deadline: toIso(f.deadline) } : {}),
                ...(f.startDate ? { startDate: f.startDate } : {}),
                ...(f.handoffId ? { handoffId: f.handoffId } : {}),
              },
              ...(toIso(f.deadline) ? { deadline: toIso(f.deadline) } : {}),
            },
          });
          setQueued(`Task ${r.taskId} ${r.executor}.`);
          await onQueued();
        });
      }}
    >
      <div className="grid-2">
        <TextField label="Topic" required value={f.topic} onChange={set("topic")} />
        <TextField label="Audience" required value={f.audience} onChange={set("audience")} />
      </div>
      <fieldset>
        <legend>Three channels</legend>
        <div className="grid-3">
          <TextField label="Channel 1" required value={f.c1} onChange={set("c1")} />
          <TextField label="Channel 2" required value={f.c2} onChange={set("c2")} />
          <TextField label="Channel 3" required value={f.c3} onChange={set("c3")} />
        </div>
      </fieldset>
      <TextField label="Voice" required value={f.voice} onChange={set("voice")} />
      <TextField label="Deliverables" required value={f.deliverables} onChange={set("deliverables")} />
      <div className="grid-2">
        <TextField label="Deadline" type="datetime-local" value={f.deadline} onChange={set("deadline")} />
        <TextField label="Calendar start (planning date)" type="date" value={f.startDate} onChange={set("startDate")} />
      </div>
      <div className="field">
        <label htmlFor={hid}>Approved research handoff</label>
        <select id={hid} value={f.handoffId} onChange={(e) => set("handoffId")(e.target.value)}>
          <option value="">None</option>
          {approved.map((h) => (
            <option key={h.id} value={h.id}>
              Handoff {h.id.slice(0, 8)} {h.note ? `— ${h.note}` : ""}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn btn-primary" disabled={disabled || action.busy}>
        Start campaign task
      </button>
      {queued ? (
        <p role="status" className="notice">
          {queued}
        </p>
      ) : null}
      <ErrorNotice error={action.error} />
    </form>
  );
}

/** Owner decision on research-to-content handoffs. Approval reserves the receiver's task allowance only. */
export function HandoffApprovals({ handoffs, agents, onChanged }: { handoffs: Handoff[]; agents: Agent[]; onChanged: () => void | Promise<void> }) {
  const action = useAction();
  const pending = handoffs.filter((h) => h.state === "pending_owner");
  const run = (id: string, decision: "approve" | "reject") =>
    void action.run(async () => {
      await decide(id, decision);
      await onChanged();
    });
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? "agent";
  if (handoffs.length === 0) return <p className="muted">No handoff requests.</p>;
  return (
    <>
      <p className="small">Approving copies the research brief to the receiving agent as a queued task under its own policy. It does not start paid work or change any policy.</p>
      <ul className="plain">
        {handoffs.map((h) => (
          <li key={h.id} className="handoff">
            {name(h.fromAgentId)} → {name(h.toAgentId)}: {h.note ?? "research brief"} · <strong>{h.state.replace(/_/g, " ")}</strong> · {when(h.createdAt)}
            {h.state === "pending_owner" ? (
              <span className="actions">
                <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => run(h.id, "approve")}>
                  Approve handoff
                </button>
                <button type="button" className="btn" disabled={action.busy} onClick={() => run(h.id, "reject")}>
                  Reject handoff
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {pending.length === 0 ? <p className="small muted">No handoffs await a decision.</p> : null}
      <ErrorNotice error={action.error} />
    </>
  );
}

const decide = (id: string, decision: "approve" | "reject") => api("control", `/handoffs/${id}/decision`, { method: "POST", body: { decision } });

export function AgentDetail({ agentId }: { agentId: string }) {
  const { workspace, reloadWorkspace } = useOwner();
  const agent = workspace.agents.find((a) => a.id === agentId);
  const tasks = useResource(() => api<{ tasks: Task[]; jobs: Job[] }>("control", `/tasks?agentId=${agentId}&limit=20`), `tasks-${agentId}`);
  const balances = useResource(() => api<Balances>("control", "/balances"), "balances");
  const activity = useResource(() => api<Activity>("control", "/activity?limit=100"), "activity");
  const content = useResource(() => api<{ items: ContentItem[] }>("control", `/content?agentId=${agentId}`), `content-${agentId}`);
  const handoffs = useResource(() => api<{ items: Handoff[] }>("control", "/handoffs"), "handoffs");
  const [draft, setDraft] = useState<AgentPolicyInput | null>(null);
  const [settings, setSettings] = useState({ name: agent?.name ?? "", description: agent?.description ?? "", modelProfile: agent?.modelProfile ?? "" });
  const save = useAction();
  const check = useAction();
  const [checkResult, setCheckResult] = useState<string | null>(null);

  if (!agent) return <p className="notice notice-error">Agent not found in this workspace.</p>;
  const reloadAll = async () => {
    await Promise.all([reloadWorkspace(), tasks.reload(), balances.reload(), activity.reload(), content.reload(), handoffs.reload()]);
  };
  const stopped = workspace.workspace.stopped;
  const canRun = agent.status === "active" && !stopped;
  const terminal = agent.status === "revoked" || agent.status === "archived";
  const wsPolicy = workspace.policies.find((p) => p.scope === "workspace" && p.status === "active");
  const drafts = workspace.policies.filter((p) => p.scope === "agent" && p.agentId === agent.id && p.status === "draft");
  const budget = balances.data?.agents.find((b) => b.agentId === agent.id);
  const cash = balances.data?.cash?.byAgent.find((c) => c.agentId === agent.id);
  const usage = balances.data?.usageByAgent?.find((u) => u.agentId === agent.id);
  const activeJob = tasks.data?.jobs.find((j) => j.state === "queued" || j.state === "leased" || j.state === "reconciling");
  const agentActivity = activity.data ? { events: activity.data.events, purchases: activity.data.purchases.filter((p) => p.agentId === agent.id) } : undefined;
  const current = policyInputOf(agent);

  return (
    <>
      <p>
        <Link href="/">← Overview</Link>
      </p>
      <h1>
        {agent.name} <span className="muted">· {ROLE_LABEL[agent.role]}</span>
      </h1>
      <p>
        <span className="pill">{agentStateLabel(agent.status, stopped)}</span> policy v{agent.policyVersion} · revocation epoch {agent.revocationEpoch}
      </p>
      <AgentControls agent={agent} onChanged={reloadAll} />

      {agent.role === "credit_manager" ? (
        <Section title="Credit check" id="run">
          <p className="small">Runs the same deterministic threshold check as the 60-second schedule. It never calls a model and respects cooldown and caps.</p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canRun || check.busy}
            onClick={() =>
              void check.run(async () => {
                const r = await api<{ check?: { decision: string; detail: string } | null; executor: string }>("control", `/agents/${agent.id}/run`, { method: "POST", body: {} });
                setCheckResult(r.check ? `${r.check.decision}: ${r.check.detail}` : r.executor);
                await reloadAll();
              })
            }
          >
            Check now
          </button>
          {checkResult ? (
            <p role="status" className="notice">
              {checkResult}
            </p>
          ) : null}
          <ErrorNotice error={check.error} what="credit check" />
        </Section>
      ) : null}
      {agent.role === "research" ? (
        <Section title="New research task" id="run">
          <ResearchForm agent={agent} disabled={!canRun} onQueued={reloadAll} />
        </Section>
      ) : null}
      {agent.role === "content" ? (
        <>
          <Section title="Research handoffs">
            {handoffs.data ? <HandoffApprovals handoffs={handoffs.data.items.filter((h) => h.toAgentId === agent.id)} agents={workspace.agents} onChanged={reloadAll} /> : <Loading label="handoffs" />}
          </Section>
          <Section title="New campaign brief" id="run">
            <CampaignForm agent={agent} disabled={!canRun} handoffs={handoffs.data?.items ?? []} onQueued={reloadAll} />
          </Section>
        </>
      ) : null}

      <Section title="Active job">
        {activeJob ? (
          <KV
            rows={[
              ["Kind", activeJob.kind],
              ["State", activeJob.state],
              ["Scheduled", when(activeJob.scheduledAt)],
              ["Attempts", String(activeJob.attempts)],
            ]}
          />
        ) : (
          <p className="muted">No queued or running job.</p>
        )}
        <ErrorNotice error={tasks.error} what="tasks" onRetry={tasks.reload} />
      </Section>

      <Section title="Spending">
        <KV
          rows={[
            ["Lifetime allowance", budget?.lifetime ? `${usdc(budget.lifetime.available)} remaining of ${usdc(budget.lifetime.limit)}` : "not activated"],
            ["Rolling 24 h", budget?.rolling24h ? `${usdc(budget.rolling24h.available)} remaining of ${usdc(budget.rolling24h.limit)}` : "—"],
            ["Cash spent / reserved", cash ? `${usdc(cash.spent)} / ${usdc(cash.reserved)}` : "—"],
            ["Credit usage", usage ? `${credits(usage.consumedUnits)} consumed, ${credits(usage.reservedUnits)} reserved` : "—"],
            ...(usage && usage.packsPurchased > 0 ? [["Credit packs bought", `${usage.packsPurchased} (${usdc(usage.packCashSpent)}, counted once in cash spent)`] as [string, string]] : []),
          ]}
        />
        {agentActivity ? <ActivityList activity={agentActivity} workspace={workspace} onChanged={reloadAll} /> : <Loading label="purchases" />}
      </Section>

      <Section title="Result history">
        {tasks.data && tasks.data.tasks.length > 0 ? (
          <ul className="plain">
            {tasks.data.tasks.map((t) => (
              <li key={t.id}>
                <strong>{t.objective}</strong> — {t.state} · {when(t.createdAt)} · tools {t.used.toolCalls}/{t.limits.maxToolCalls}, purchases {t.used.paidPurchases}/{t.limits.maxPaidPurchases}, planning {t.used.planningCalls}/
                {t.limits.maxPlanningCalls} · budget {usdc(t.limits.taskUsdc)}
              </li>
            ))}
          </ul>
        ) : null}
        {tasks.data ? (
          <ul className="plain small">
            {tasks.data.jobs
              .filter((j) => j.state === "completed" || j.state === "failed")
              .map((j) => (
                <li key={j.id}>
                  {when(j.updatedAt)} — {summarizeResult(j, tasks.data?.tasks.find((t) => t.id === j.taskId))}
                </li>
              ))}
          </ul>
        ) : (
          <Loading label="results" />
        )}
        {content.data && content.data.items.length > 0 ? (
          <p>
            {content.data.items.length} saved artifact(s). <Link href="/content">Open content</Link>
          </p>
        ) : null}
      </Section>

      <Section title="Settings and trigger" id="settings">
        <KV
          rows={[
            ["Job", agent.description ?? "—"],
            ["Trigger", Object.entries(agent.trigger).map(([k, v]) => `${k}: ${String(v)}`).join(", ") || "—"],
            ["Model profile", agent.modelProfile ?? "default"],
          ]}
        />
        {current ? <PolicyReview policy={agent.activePolicy!} workspacePolicy={wsPolicy} title={`Active policy v${agent.activePolicy!.version}`} /> : <p className="notice notice-warn">No active policy: this agent cannot spend.</p>}
        {drafts.map((d) => (
          <div key={d.id} className="draft-policy">
            <PolicyReview policy={d} workspacePolicy={wsPolicy} title={`Draft policy v${d.version} (not active)`} />
            <button
              type="button"
              className="btn btn-primary"
              disabled={save.busy || terminal}
              onClick={() =>
                void save.run(async () => {
                  await api("control", `/agents/${agent.id}/config`, { method: "PATCH", body: { activatePolicyVersion: d.version } });
                  await reloadAll();
                })
              }
            >
              Activate policy v{d.version}
            </button>
          </div>
        ))}
        {!terminal ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save.run(async () => {
                const body: Record<string, unknown> = {};
                if (settings.name && settings.name !== agent.name) body.name = settings.name;
                if (settings.description && settings.description !== (agent.description ?? "")) body.description = settings.description;
                if (settings.modelProfile && settings.modelProfile !== (agent.modelProfile ?? "")) body.modelProfile = settings.modelProfile;
                if (draft) body.policy = draft;
                if (Object.keys(body).length === 0) return;
                await api("control", `/agents/${agent.id}/config`, { method: "PATCH", body });
                setDraft(null);
                await reloadAll();
              });
            }}
          >
            <h3>Edit settings</h3>
            <div className="grid-3">
              <TextField label="Name" value={settings.name} onChange={(v) => setSettings({ ...settings, name: v })} />
              <TextField label="Job description" value={settings.description} onChange={(v) => setSettings({ ...settings, description: v })} />
              <TextField label="Model profile" value={settings.modelProfile} onChange={(v) => setSettings({ ...settings, modelProfile: v })} />
            </div>
            {current ? <PolicyForm initial={current} workspace={workspace} onChange={setDraft} /> : null}
            <p className="small">Saving a policy change creates a new draft version; it takes effect only after you activate it.</p>
            <button type="submit" className="btn btn-primary" disabled={save.busy}>
              Save settings{draft ? " and create policy draft" : ""}
            </button>
          </form>
        ) : null}
        <ErrorNotice error={save.error} />
      </Section>
    </>
  );
}
