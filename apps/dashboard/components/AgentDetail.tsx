"use client";

import Link from "next/link";
import { Fragment, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import { useAgentAvatar, setAgentAvatar } from "../lib/avatars";
import { credits, parseUsdcInput, usdc, when } from "../lib/format";
import { REVIEW_LABEL, ROLE_LABEL, agentStateLabel, purchaseLabel, runBlockedReason } from "../lib/labels";
import type { Activity, Agent, Balances, ContentItem, Handoff, Job, LimitUsage, Purchase, Task } from "../lib/types";
import { ActivityDrawer } from "./Activity";
import { summarizeResult } from "../lib/results";
import { AgentControls } from "./AgentControls";
import { AgentConnectors } from "./AgentConnectors";
import { CustomAgentPanel } from "./CustomAgentFields";
import { AgentAvatar, AvatarImage, AvatarPicker } from "./Avatar";
import { Icon } from "./Icon";
import { Select } from "./Select";
import { PolicyForm, PolicyReview, type AgentPolicyInput } from "./Policy";
import { useCapability, useOwner } from "./Shell";
import { useAction, usePolling, useResource } from "./hooks";
import { DeniedHint, ErrorNotice, KV, Loading } from "./ui";
import { AgentWorkflows } from "./market/AgentWorkflows";

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

/** Enter sends, Shift+Enter adds a line. */
function submitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  }
}

function Queued({ text }: { text: string | null }) {
  return text ? (
    <p role="status" className="small muted">
      {text}
    </p>
  ) : null;
}

/** Prince: research question, optional sources and deadline. Queues a task; the runner executes it. */
export function ResearchForm({ agent, disabled: blocked, onQueued }: { agent: Agent; disabled: boolean; onQueued: () => void | Promise<void> }) {
  const run = useCapability("run");
  const budgetCap = useCapability("configure");
  const disabled = blocked || !run.allowed;
  const [question, setQuestion] = useState("");
  const [sources, setSources] = useState("");
  const [deadline, setDeadline] = useState("");
  const [budget, setBudget] = useState("");
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const action = useAction();
  const [queued, setQueued] = useState<string | null>(null);
  const qid = useId();
  const sid = useId();
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled || action.busy || question.trim() === "") return;
        const limit = budget.trim() && budgetCap.allowed ? parseUsdcInput(budget) : null;
        if (budget.trim() && budgetCap.allowed && limit === null) {
          setBudgetError("Enter a task budget such as 0.01, with up to six decimal places, or leave it blank to use the policy budget.");
          return;
        }
        setBudgetError(null);
        void action.run(async () => {
          const list = sources
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean);
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
          setQuestion("");
          await onQueued();
        });
      }}
    >
      <div className="composer-box">
        <label htmlFor={qid} className="sr-only">
          Research question
        </label>
        <textarea
          id={qid}
          rows={1}
          value={question}
          disabled={disabled || action.busy}
          placeholder={!run.allowed ? (run.reason ?? "") : disabled ? `${agent.name} cannot take tasks right now` : `Ask ${agent.name} a research question`}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={submitOnEnter}
        />
        <button type="submit" className="send-btn" aria-label="Start research task" disabled={disabled || action.busy || question.trim() === ""}>
          <Icon name="send" />
        </button>
      </div>
      <details className="composer-more">
        <summary>Sources, deadline and budget</summary>
        <div className="field">
          <label htmlFor={sid}>Optional sources (URLs, one per line)</label>
          <textarea id={sid} rows={2} value={sources} onChange={(e) => setSources(e.target.value)} aria-describedby={`${sid}-h`} />
          <span id={`${sid}-h`} className="hint">
            Only approved services are purchased; suggested sources are untrusted input.
          </span>
        </div>
        <div className="grid-2">
          <TextField label="Deadline" type="datetime-local" value={deadline} onChange={setDeadline} />
          {budgetCap.allowed ? (
            <TextField label="Task budget (USDC, optional)" value={budget} onChange={setBudget} hint="Defaults to the policy's per-task budget." />
          ) : (
            <p className="hint">Runs use the policy&apos;s per-task budget. Only the owner can set a different one.</p>
          )}
        </div>
      </details>
      {budgetError ? <p role="alert" className="notice notice-error">{budgetError}</p> : null}
      {!run.allowed ? <DeniedHint reason={run.reason} /> : null}
      <Queued text={queued} />
      <ErrorNotice error={action.error} />
    </form>
  );
}

/** Mira: campaign brief, optionally attached to an owner-approved handoff. */
export function CampaignForm({ agent, disabled: blocked, handoffs, onQueued }: { agent: Agent; disabled: boolean; handoffs: Handoff[]; onQueued: () => void | Promise<void> }) {
  const run = useCapability("run");
  const disabled = blocked || !run.allowed;
  const [f, setF] = useState({ topic: "", audience: "", c1: "", c2: "", c3: "", voice: "", deliverables: "Three channel drafts and a seven-day content calendar", deadline: "", startDate: "", handoffId: "" });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const action = useAction();
  const [queued, setQueued] = useState<string | null>(null);
  const hid = useId();
  const tid = useId();
  const [more, setMore] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const approved = handoffs.filter((h) => h.toAgentId === agent.id && h.state === "approved");
  const REQUIRED: Array<[keyof typeof f, string]> = [
    ["topic", "topic"],
    ["audience", "audience"],
    ["c1", "channel 1"],
    ["c2", "channel 2"],
    ["c3", "channel 3"],
    ["voice", "voice"],
    ["deliverables", "deliverables"],
  ];
  return (
    <form
      className="composer"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled || action.busy) return;
        const empty = REQUIRED.filter(([k]) => f[k].trim() === "").map(([, label]) => label);
        setMissing(empty);
        if (empty.length > 0) {
          setMore(true);
          return;
        }
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
      <div className="composer-box">
        <label htmlFor={tid} className="sr-only">
          Campaign topic
        </label>
        <textarea
          id={tid}
          rows={1}
          required
          value={f.topic}
          disabled={disabled || action.busy}
          placeholder={!run.allowed ? (run.reason ?? "") : disabled ? `${agent.name} cannot take tasks right now` : `Brief ${agent.name}: campaign topic`}
          onChange={(e) => set("topic")(e.target.value)}
          onKeyDown={submitOnEnter}
        />
        <button type="submit" className="send-btn" aria-label="Start campaign task" disabled={disabled || action.busy}>
          <Icon name="send" />
        </button>
      </div>
      <details className="composer-more" open={more} onToggle={(e) => setMore(e.currentTarget.open)}>
        <summary>Audience, channels, voice and dates</summary>
        <TextField label="Audience" required value={f.audience} onChange={set("audience")} />
        <div className="grid-3">
          <TextField label="Channel 1" required value={f.c1} onChange={set("c1")} />
          <TextField label="Channel 2" required value={f.c2} onChange={set("c2")} />
          <TextField label="Channel 3" required value={f.c3} onChange={set("c3")} />
        </div>
        <div className="grid-2">
          <TextField label="Voice" required value={f.voice} onChange={set("voice")} />
          <TextField label="Deliverables" required value={f.deliverables} onChange={set("deliverables")} />
          <TextField label="Deadline" type="datetime-local" value={f.deadline} onChange={set("deadline")} />
          <TextField label="Calendar start (planning date)" type="date" value={f.startDate} onChange={set("startDate")} />
        </div>
        <div className="field">
          <label htmlFor={hid}>Use approved research</label>
          <Select
            id={hid}
            label="Use approved research"
            value={f.handoffId}
            onChange={(v) => set("handoffId")(v)}
            options={[{ value: "", label: "None" }, ...approved.map((h) => ({ value: h.id, label: h.note ? h.note : `Research ${h.id.slice(0, 8)}` }))]}
          />
        </div>
      </details>
      {missing.length > 0 ? (
        <p role="alert" className="small notice notice-warn">
          Fill in {missing.join(", ")} before sending.
        </p>
      ) : null}
      {!run.allowed ? <DeniedHint reason={run.reason} /> : null}
      <Queued text={queued} />
      <ErrorNotice error={action.error} />
    </form>
  );
}

/** Owner decision on research-to-content handoffs. Approval reserves the receiver's task allowance only. */
export function HandoffApprovals({ handoffs, agents, onChanged }: { handoffs: Handoff[]; agents: Agent[]; onChanged: () => void | Promise<void> }) {
  const action = useAction();
  const decideCap = useCapability("decide");
  const pending = handoffs.filter((h) => h.state === "pending_owner");
  const run = (id: string, decision: "approve" | "reject") =>
    void action.run(async () => {
      await decide(id, decision);
      await onChanged();
    });
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? "agent";
  if (handoffs.length === 0) return <p className="muted flush">Nothing shared yet.</p>;
  return (
    <>
      <p className="hint">Approving gives the brief to the other agent as a task. It doesn&apos;t start paid work.</p>
      <ul className="plain">
        {handoffs.map((h) => (
          <li key={h.id} className="handoff">
            {name(h.fromAgentId)} → {name(h.toAgentId)}: {h.note ?? "research brief"} · <strong>{h.state.replace(/_/g, " ")}</strong> · {when(h.createdAt)}
            {h.state === "pending_owner" ? (
              <span className="actions">
                <button type="button" className="btn btn-primary" disabled={action.busy || !decideCap.allowed} onClick={() => run(h.id, "approve")}>
                  Approve handoff
                </button>
                <button type="button" className="btn" disabled={action.busy || !decideCap.allowed} onClick={() => run(h.id, "reject")}>
                  Reject handoff
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {pending.length === 0 ? <p className="small muted flush">Nothing waiting for you.</p> : <DeniedHint reason={decideCap.reason} />}
      <ErrorNotice error={action.error} />
    </>
  );
}

const decide = (id: string, decision: "approve" | "reject") => api("control", `/handoffs/${id}/decision`, { method: "POST", body: { decision } });


interface ThreadEntry {
  at: string;
  key: string;
  node: ReactNode;
}

function dayLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

function ResultText({ text }: { text: string }) {
  const [head, ...rest] = text.split(" · ");
  return (
    <>
      <strong className="bubble-title">{head}</strong>
      {rest.map((line, i) => (
        <span key={i} className="bubble-line">
          {line}
        </span>
      ))}
    </>
  );
}

/** Thread entries come only from recorded tasks, finished jobs, purchases and saved content. */
function buildThread(
  tasks: Task[],
  jobs: Job[],
  purchases: Purchase[],
  items: ContentItem[],
  agentStopped: boolean,
  openPurchase: (id: string) => void,
): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  for (const t of tasks) {
    out.push({
      at: t.createdAt,
      key: `t-${t.id}`,
      node: (
        <li className="bubble bubble-owner">
          {t.objective}
          <span className="bubble-meta">
            Task {t.state.replace(/_/g, " ")} · budget {usdc(t.limits.taskUsdc)} · {when(t.createdAt)}
          </span>
        </li>
      ),
    });
  }
  for (const j of jobs.filter((x) => x.state === "completed" || x.state === "failed")) {
    out.push({
      at: j.updatedAt,
      key: `j-${j.id}`,
      node: (
        <li className="bubble bubble-agent">
          <ResultText text={summarizeResult(j, tasks.find((t) => t.id === j.taskId))} />
          <span className="bubble-meta">
            {j.kind.replace(/_/g, " ")} · {when(j.updatedAt)}
          </span>
        </li>
      ),
    });
  }
  for (const p of purchases) {
    out.push({
      at: p.createdAt,
      key: `p-${p.id}`,
      node: (
        <li className="thread-item">
          <button type="button" className="attachment" aria-haspopup="dialog" onClick={() => openPurchase(p.id)}>
            <span className="attachment-icon">
              <Icon name="card" />
            </span>
            <span className="attachment-text">
              <strong>
                {p.sku} · {p.paymentPath === "prepaid_credits" ? credits(p.usage.amount) : usdc(p.price.amount)}
              </strong>
              <span>{purchaseLabel(p, { agentStopped })}</span>
            </span>
            <Icon name="arrow" size={16} />
          </button>
        </li>
      ),
    });
  }
  for (const c of items) {
    out.push({
      at: c.createdAt,
      key: `c-${c.id}`,
      node: (
        <li className="thread-item">
          <Link href="/content" className="attachment">
            <span className="attachment-icon">
              <Icon name="file" />
            </span>
            <span className="attachment-text">
              <strong>{c.title}</strong>
              <span>
                {c.kind.replace(/_/g, " ")} · revision {c.revision} · {REVIEW_LABEL[c.reviewState] ?? c.reviewState}
              </span>
            </span>
            <Icon name="arrow" size={16} />
          </Link>
        </li>
      ),
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

function Routines({ agent, stopped }: { agent: Agent; stopped: boolean }) {
  const t = agent.trigger as { type?: string; pollSeconds?: number };
  const running = agent.status === "active" && !stopped;
  const rows: Array<[string, string]> =
    t.type === "low_credit_balance"
      ? [[`Credit check every ${t.pollSeconds ?? 60} s`, running ? "Scheduled" : "Paused until the agent is active"]]
      : [["Runs when you send a task", running ? "Ready" : "Not accepting tasks"]];
  return (
    <ul className="routines">
      {rows.map(([title, sub]) => (
        <li key={title} className={running ? "" : "paused"}>
          <Icon name={running ? "clock" : "pause"} />
          <div>
            {title}
            <span>{sub}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Share of a limit already used, for the bar only; the text shows the exact amounts. */
function usedPercent(u: LimitUsage): number {
  const limit = BigInt(u.limit);
  if (limit === 0n) return 0;
  const used = limit - BigInt(u.available);
  return Math.max(0, Math.min(100, Number((used * 100n) / limit)));
}

function LimitBar({ label, u }: { label: string; u: LimitUsage | undefined }) {
  return (
    <div className="limit">
      <div className="limit-head">
        <span>{label}</span>
        <span>{u ? `${usdc(u.available)} left` : "—"}</span>
      </div>
      {u ? (
        <>
          <div className="bar" aria-hidden="true">
            <span style={{ width: `${usedPercent(u)}%` }} />
          </div>
          <span className="limit-sub">of {usdc(u.limit)}</span>
        </>
      ) : null}
    </div>
  );
}

function AvatarSettings({ agent }: { agent: Agent }) {
  const current = useAgentAvatar(agent.id, agent.role);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Done" : "Change avatar"}
      </button>
      {open ? (
        <div className="avatar-settings">
          <AvatarPicker value={current.id} onChange={(id) => setAgentAvatar(agent.id, id)} label={`${agent.name} avatar`} />
          <p className="hint">Saved in this browser only.</p>
        </div>
      ) : null}
    </>
  );
}

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
  const [openPurchaseId, setOpenPurchaseId] = useState<string | null>(null);
  const save = useAction();
  const check = useAction();
  const runCap = useCapability("run");
  const configure = useCapability("configure");
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const avatar = useAgentAvatar(agentId, agent?.role ?? "research");

  const reloadAll = async () => {
    // Read the job state first so its final artifacts cannot be missed when polling stops.
    await tasks.reload();
    await Promise.all([reloadWorkspace(), balances.reload(), activity.reload(), content.reload(), handoffs.reload()]);
  };
  const activeJob = tasks.data?.jobs.find((j) => j.state === "queued" || j.state === "leased" || j.state === "reconciling");
  usePolling(reloadAll, agentId, activeJob !== undefined);
  if (!agent) return <p className="notice notice-error">Agent not found in this workspace.</p>;
  const activateDraft = (version: number) =>
    void save.run(async () => {
      await api("control", `/agents/${agent.id}/config`, { method: "PATCH", body: { activatePolicyVersion: version } });
      await reloadAll();
    });
  const stopped = workspace.workspace.stopped;
  const canRun = agent.status === "active" && !stopped;
  const terminal = agent.status === "revoked" || agent.status === "archived";
  const agentStopped = stopped || agent.status !== "active";
  const wsPolicy = workspace.policies.find((p) => p.scope === "workspace" && p.status === "active");
  const drafts = workspace.policies.filter((p) => p.scope === "agent" && p.agentId === agent.id && p.status === "draft");
  const budget = balances.data?.agents.find((b) => b.agentId === agent.id);
  const cash = balances.data?.cash?.byAgent.find((c) => c.agentId === agent.id);
  const usage = balances.data?.usageByAgent?.find((u) => u.agentId === agent.id);
  const purchases = activity.data?.purchases.filter((p) => p.agentId === agent.id) ?? [];
  const openPurchase = purchases.find((p) => p.id === openPurchaseId);
  const current = policyInputOf(agent);
  const loaded = tasks.data !== undefined && activity.data !== undefined && content.data !== undefined;
  const entries = tasks.data && content.data ? buildThread(tasks.data.tasks, tasks.data.jobs, purchases, content.data.items, agentStopped, setOpenPurchaseId) : [];
  const blocked = runBlockedReason(agent.status, stopped);
  const tz = workspace.workspace.timezone || "UTC";

  let lastDay = "";
  const threadNodes: ReactNode[] = [];
  for (const e of entries) {
    const day = dayLabel(e.at, tz);
    if (day !== lastDay) {
      threadNodes.push(
        <li key={`d-${day}`} className="thread-day" aria-hidden="true">
          {day}
        </li>,
      );
      lastDay = day;
    }
    threadNodes.push(<Fragment key={e.key}>{e.node}</Fragment>);
  }

  return (
    <div className="agent-view">
      <section className="thread-panel" aria-label={`${agent.name} thread`}>
        <header className="thread-head">
          <AgentAvatar agent={agent} size={36} />
          <div>
            <h1>{agent.name}</h1>
            <p className="role">{ROLE_LABEL[agent.role]}</p>
          </div>
          <span className={`pill pill-${canRun ? "ok" : agent.status === "paused" || agent.status === "draft" ? "warn" : "danger"}`}>{agentStateLabel(agent.status, stopped)}</span>
        </header>
        {blocked ? (
          <div className="notice notice-warn thread-notice" role="status">
            {blocked}
            {agent.status === "draft" && drafts.length > 0 ? (
              <button
                type="button"
                className="btn btn-small btn-primary"
                disabled={save.busy || !configure.allowed}
                title={configure.reason ?? undefined}
                onClick={() => activateDraft(drafts.at(-1)!.version)}
              >
                Turn on with these limits
              </button>
            ) : null}
          </div>
        ) : null}
        <ol className="thread" aria-label="Tasks, results and payments">
          {!loaded ? (
            <li className="thread-empty">
              <Loading label="thread" />
            </li>
          ) : threadNodes.length === 0 ? (
            <li className="thread-empty">
              {agent.role === "credit_manager"
                ? `No credit checks recorded yet. ${agent.name} checks on schedule once its policy is active, or use Check now.`
                : canRun
                  ? `No tasks yet. Send ${agent.name} a task below.`
                  : `No tasks yet. ${agent.name} can take tasks once its policy is active and it is not stopped.`}
            </li>
          ) : (
            threadNodes
          )}
        </ol>
        <ErrorNotice error={tasks.error ?? activity.error ?? content.error} what="thread" onRetry={reloadAll} />
        {agent.role === "credit_manager" ? (
          <div className="composer">
            <div className="composer-box composer-static">
              <span className="small muted">Runs the same deterministic threshold check as the schedule. It never calls a model.</span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canRun || check.busy || !runCap.allowed}
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
            </div>
            {!runCap.allowed ? <DeniedHint reason={runCap.reason} /> : null}
            <Queued text={checkResult} />
            <ErrorNotice error={check.error} what="credit check" />
          </div>
        ) : null}
        {agent.role === "research" ? <ResearchForm agent={agent} disabled={!canRun} onQueued={reloadAll} /> : null}
        {agent.role === "content" ? <CampaignForm agent={agent} disabled={!canRun} handoffs={handoffs.data?.items ?? []} onQueued={reloadAll} /> : null}
        {agent.role === "custom" ? <CustomAgentPanel part="composer" agent={agent} policy={current} canRun={canRun} terminal={terminal} onChanged={reloadAll} /> : null}
        {configure.allowed ? <AgentWorkflows agentId={agentId} /> : null}
      </section>

      <aside className="details-panel" aria-label={`${agent.name} details`}>
        <div className="panel">
          <div className="details-avatar">
            <AvatarImage avatar={avatar} size={72} />
            <strong>{agent.name}</strong>
            <span className="small muted">{ROLE_LABEL[agent.role]}</span>
            <AvatarSettings agent={agent} />
          </div>
          <AgentControls agent={agent} onChanged={reloadAll} compact />
        </div>
        {agent.role === "custom" ? <CustomAgentPanel part="details" agent={agent} policy={current} canRun={canRun} terminal={terminal} onChanged={reloadAll} /> : null}

        <div className="panel">
          <h2 className="section-title">Status</h2>
          <Routines agent={agent} stopped={stopped} />
          <p className="small muted flush routines-foot">
            {activeJob ? `${activeJob.kind.replace(/_/g, " ")} ${activeJob.state} · attempt ${activeJob.attempts}` : "No job running"}
          </p>
        </div>

        <div className="panel">
          <h2 className="section-title">Spending</h2>
          <LimitBar label="Lifetime" u={budget?.lifetime} />
          <LimitBar label="Last 24 h" u={budget?.rolling24h} />
          <KV
            rows={[
              ["Spent", cash ? usdc(cash.spent) : "—"],
              ["Reserved", cash ? usdc(cash.reserved) : "—"],
              ["Credits used", usage ? credits(usage.consumedUnits) : "—"],
              ...(usage && usage.packsPurchased > 0 ? [["Credit packs", `${usage.packsPurchased} (${usdc(usage.packCashSpent)}, in spent)`] as [string, string]] : []),
            ]}
          />
          <p className="small muted section-foot">
            {purchases.length} purchase{purchases.length === 1 ? "" : "s"} · <Link href="/activity">Activity</Link>
          </p>
        </div>

        <AgentConnectors agent={agent} />

        {agent.role === "content" ? (
          <div className="panel">
            <h2 className="section-title">Research handoffs</h2>
            {handoffs.data ? <HandoffApprovals handoffs={handoffs.data.items.filter((h) => h.toAgentId === agent.id)} agents={workspace.agents} onChanged={reloadAll} /> : <Loading label="handoffs" />}
          </div>
        ) : null}

        <details className="panel disclosure" id="settings" open={agent.status === "draft" || undefined}>
          <summary>Policy and settings</summary>
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
                disabled={save.busy || terminal || !configure.allowed}
                onClick={() => activateDraft(d.version)}
              >
                Use these limits
              </button>
            </div>
          ))}
          {!terminal && !configure.allowed ? <DeniedHint reason={configure.reason} /> : null}
          {!terminal && configure.allowed ? (
            <details>
              <summary className="small">Edit settings and policy</summary>
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
                <TextField label="Name" value={settings.name} onChange={(v) => setSettings({ ...settings, name: v })} />
                <TextField label="Job description" value={settings.description} onChange={(v) => setSettings({ ...settings, description: v })} />
                <TextField label="Model profile" value={settings.modelProfile} onChange={(v) => setSettings({ ...settings, modelProfile: v })} />
                {current ? <PolicyForm initial={current} workspace={workspace} onChange={setDraft} /> : null}
                <p className="small">Saving a policy change creates a new draft version; it takes effect only after you activate it.</p>
                <button type="submit" className="btn btn-primary" disabled={save.busy}>
                  Save settings{draft ? " and create policy draft" : ""}
                </button>
              </form>
            </details>
          ) : null}
          <ErrorNotice error={save.error} />
        </details>
      </aside>
      {openPurchase && activity.data ? (
        <ActivityDrawer purchase={openPurchase} events={activity.data.events} workspace={workspace} onClose={() => setOpenPurchaseId(null)} onChanged={reloadAll} />
      ) : null}
    </div>
  );
}
