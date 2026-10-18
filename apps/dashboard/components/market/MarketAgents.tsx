"use client";

import { useId, useState } from "react";
import { when } from "../../lib/format";
import { parseUnits } from "../../lib/market/amounts";
import { marketApi, supabase } from "../../lib/market/client";
import { DECIMALS_UNVERIFIED } from "../../lib/market/messages";
import { AGENT_TOOLS, type CatalogEntry, type MarketAgent, type PolicyProposal } from "../../lib/market/types";
import { useAction, useResource } from "../hooks";
import { ConfirmButton, EmptyState, ErrorNotice, Loading, Section } from "../ui";
import { ControllerPanel } from "./ControllerPanel";
import { useMarket } from "./MarketContext";
import { Money, PausedNotice, PlainText, RequireMarketSession } from "./parts";

const TOOL_LABEL: Record<(typeof AGENT_TOOLS)[number], string> = {
  marketplace_search: "Search the marketplace",
  propose_hire: "Propose a hire (owner and local controller still decide)",
  web_read: "Read public web pages",
};

export function MarketAgents() {
  return (
    <>
      <h1>Marketplace agents</h1>
      <p className="small">
        Agents and policies created here are <strong>proposals</strong>. They stay inactive until your local controller installs and acknowledges them.
      </p>
      <RequireMarketSession what="manage marketplace agents">
        <ControllerPanel />
        <Agents />
      </RequireMarketSession>
    </>
  );
}

async function loadAgents(): Promise<{ agents: MarketAgent[]; proposals: PolicyProposal[] }> {
  const db = supabase();
  const [agents, proposals] = await Promise.all([
    db.from("agents").select("id, name, purpose, status, tools, discovery_enabled, auto_hire_enabled, local_agent_id, created_at").order("created_at", { ascending: false }),
    db
      .from("agent_policy_proposals")
      .select(
        "agent_id, version, per_task_cap:per_task_cap::text, per_agent_cap:per_agent_cap::text, max_payment:max_payment::text, period_hours, allowed_listing_ids, status, acknowledged_at, created_at",
      )
      .order("version", { ascending: false }),
  ]);
  if (agents.error) throw new Error(agents.error.message);
  if (proposals.error) throw new Error(proposals.error.message);
  return { agents: (agents.data ?? []) as MarketAgent[], proposals: (proposals.data ?? []) as PolicyProposal[] };
}

function Agents() {
  const m = useMarket();
  const res = useResource(loadAgents, `agents:${m.me?.userId ?? ""}`);
  return (
    <>
      <PausedNotice />
      <CreateMarketAgent onCreated={res.reload} />
      <Section title="Your agents">
        {res.loading && !res.data ? <Loading label="agents" /> : null}
        <ErrorNotice error={res.error} what="agents could not be loaded" onRetry={res.reload} />
        {res.data && res.data.agents.length === 0 ? <EmptyState>No marketplace agents yet.</EmptyState> : null}
        {res.data?.agents.map((a) => (
          <AgentItem key={a.id} agent={a} proposals={res.data!.proposals.filter((p) => p.agent_id === a.id)} onChanged={res.reload} />
        ))}
      </Section>
    </>
  );
}

function CreateMarketAgent({ onCreated }: { onCreated: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const [f, setF] = useState({ name: "", purpose: "", instructions: "", tools: [] as string[], discovery: false, autoHire: false });
  const id = useId();
  return (
    <Section title="Create an agent">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await m.call("/agents", {
              method: "POST",
              body: { name: f.name.trim(), purpose: f.purpose.trim(), instructions: f.instructions, tools: f.tools, discoveryEnabled: f.discovery, autoHireEnabled: f.autoHire },
            });
            setF({ name: "", purpose: "", instructions: "", tools: [], discovery: false, autoHire: false });
            await onCreated();
          });
        }}
      >
        <div className="grid-2">
          <div className="field">
            <label htmlFor={`${id}-name`}>Name *</label>
            <input id={`${id}-name`} required maxLength={64} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-purpose`}>Purpose *</label>
            <input id={`${id}-purpose`} required maxLength={500} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${id}-instr`}>Instructions</label>
          <textarea id={`${id}-instr`} rows={3} maxLength={8000} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
        </div>
        <fieldset>
          <legend>Tools</legend>
          <div className="checks">
            {AGENT_TOOLS.map((t) => (
              <label key={t}>
                <input
                  type="checkbox"
                  checked={f.tools.includes(t)}
                  onChange={(e) => setF({ ...f, tools: e.target.checked ? [...f.tools, t] : f.tools.filter((x) => x !== t) })}
                />{" "}
                {TOOL_LABEL[t]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Discovery and hiring (off by default)</legend>
          <label className="field inline">
            <input type="checkbox" checked={f.discovery} onChange={(e) => setF({ ...f, discovery: e.target.checked })} /> Let this agent discover specialists
          </label>
          <label className="field inline">
            <input type="checkbox" checked={f.autoHire} onChange={(e) => setF({ ...f, autoHire: e.target.checked })} /> Let this agent propose hires within its policy
          </label>
          <p className="hint">Even with these on, every payment is still authorized by your local controller against its own limits.</p>
        </fieldset>
        <button type="submit" className="btn btn-primary" disabled={!m.canAct || action.busy || f.name.trim() === "" || f.purpose.trim() === ""}>
          Create agent (inactive)
        </button>
        <ErrorNotice error={action.error} what="agent not created" />
      </form>
    </Section>
  );
}

function AgentItem({ agent, proposals, onChanged }: { agent: MarketAgent; proposals: PolicyProposal[]; onChanged: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const [proposing, setProposing] = useState(false);
  const terminal = agent.status === "revoked" || agent.status === "archived";
  const setStatus = (status: "paused" | "revoked" | "archived") =>
    action.run(async () => {
      await m.call(`/agents/${agent.id}/status`, { method: "POST", body: { status } });
      await onChanged();
    });
  return (
    <article className="content-item">
      <div className="card-head">
        <h3>{agent.name}</h3>
        <span className={agent.status === "active" ? "pill pill-ok" : agent.status === "inactive" ? "pill pill-warn" : "pill"}>{agent.status}</span>
      </div>
      <PlainText text={agent.purpose} className="small" />
      <p className="small muted">
        Tools: {agent.tools.length ? agent.tools.join(", ") : "none"} · discovery {agent.discovery_enabled ? "on" : "off"} · hire proposals{" "}
        {agent.auto_hire_enabled ? "on" : "off"} · local agent {agent.local_agent_id ?? "not linked yet"}
      </p>
      {agent.status === "inactive" ? (
        <p className="small notice" role="note">
          Inactive until your local controller acknowledges this agent&apos;s policy.
        </p>
      ) : null}
      <h4>Policy proposals</h4>
      {proposals.length === 0 ? (
        <p className="small muted">No policy proposed.</p>
      ) : (
        <ul className="plain">
          {proposals.map((p) => (
            <li key={p.version}>
              v{p.version} ·{" "}
              <span className={p.status === "acknowledged" ? "pill pill-ok" : p.status === "rejected" ? "pill pill-danger" : "pill pill-warn"}>
                {p.status === "proposed" ? "inactive until your local controller acknowledges" : p.status}
              </span>{" "}
              · max payment <Money amount={p.max_payment} decimals={m.token?.decimals} /> · per task <Money amount={p.per_task_cap} decimals={m.token?.decimals} /> · per agent{" "}
              <Money amount={p.per_agent_cap} decimals={m.token?.decimals} /> per {p.period_hours} h · {p.allowed_listing_ids.length} allowed listings
              {p.acknowledged_at ? <span className="small muted"> · acknowledged {when(p.acknowledged_at)}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="actions" role="group" aria-label={`${agent.name} controls`}>
        <button type="button" className="btn" aria-expanded={proposing} disabled={terminal} onClick={() => setProposing(!proposing)}>
          {proposing ? "Close policy form" : "Propose policy"}
        </button>
        <button type="button" className="btn" disabled={!m.canAct || action.busy || terminal || agent.status === "paused"} onClick={() => void setStatus("paused")}>
          Pause {agent.name}
        </button>
        <ConfirmButton
          label={`Revoke ${agent.name}`}
          confirmLabel={`Confirm revoke ${agent.name}`}
          danger
          disabled={!m.canAct || action.busy || terminal}
          warning="Revocation is permanent for this marketplace agent."
          onConfirm={() => void setStatus("revoked")}
        />
        <ConfirmButton
          label={`Archive ${agent.name}`}
          confirmLabel={`Confirm archive ${agent.name}`}
          disabled={!m.canAct || action.busy || agent.status === "archived"}
          warning="Archived agents keep their records and cannot be used."
          onConfirm={() => void setStatus("archived")}
        />
      </div>
      <ErrorNotice error={action.error} what="agent action failed" />
      {proposing ? (
        <PolicyProposalForm
          agent={agent}
          onDone={async () => {
            setProposing(false);
            await onChanged();
          }}
        />
      ) : null}
    </article>
  );
}

function PolicyProposalForm({ agent, onDone }: { agent: MarketAgent; onDone: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const decimals = m.token?.decimals ?? null;
  const [f, setF] = useState({ perTask: "", perAgent: "", maxPayment: "", periodHours: "24" });
  const [allowed, setAllowed] = useState<string[]>([]);
  const catalogue = useResource(() => marketApi<{ listings: CatalogEntry[] }>("/marketplace/listings?limit=50"), "policy-catalogue");
  const id = useId();
  const parse = (v: string) => (decimals === null ? null : parseUnits(v, decimals));
  const parsed = { perTask: parse(f.perTask), perAgent: parse(f.perAgent), maxPayment: parse(f.maxPayment) };
  const errorOf = (k: keyof typeof parsed) => (f[k] === "" ? null : parsed[k] === null ? DECIMALS_UNVERIFIED : parsed[k]!.ok ? null : (parsed[k] as { error: string }).error);
  const allOk = parsed.perTask?.ok && parsed.perAgent?.ok && parsed.maxPayment?.ok;
  let nestError: string | null = null;
  if (allOk) {
    const [t, a, mx] = [parsed.perTask, parsed.perAgent, parsed.maxPayment].map((p) => BigInt((p as { value: string }).value)) as [bigint, bigint, bigint];
    if (!(mx <= t && t <= a)) nestError = "Limits must nest: max payment ≤ per task ≤ per agent.";
  }
  const hours = Number(f.periodHours);
  const hoursOk = Number.isInteger(hours) && hours >= 1 && hours <= 8760;
  const amountField = (k: "maxPayment" | "perTask" | "perAgent", label: string) => {
    const err = errorOf(k);
    return (
      <div className="field">
        <label htmlFor={`${id}-${k}`}>{label} *</label>
        <input id={`${id}-${k}`} required inputMode="decimal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} disabled={decimals === null} aria-invalid={err ? true : undefined} aria-describedby={`${id}-${k}-h`} />
        <span id={`${id}-${k}-h`} className={err ? "hint field-error" : "hint"} role={err ? "alert" : undefined}>
          {err ?? "USDC, decimal"}
        </span>
      </div>
    );
  };
  return (
    <form
      className="policy-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!allOk || nestError || !hoursOk) return;
        void action.run(async () => {
          await m.call(`/agents/${agent.id}/policy-proposals`, {
            method: "POST",
            body: {
              perTaskCap: (parsed.perTask as { value: string }).value,
              perAgentCap: (parsed.perAgent as { value: string }).value,
              maxPayment: (parsed.maxPayment as { value: string }).value,
              periodHours: hours,
              allowedListingIds: allowed,
            },
          });
          await onDone();
        });
      }}
    >
      <h4>Propose a policy for {agent.name}</h4>
      {decimals === null ? <p className="notice notice-warn small">Amount entry disabled: {DECIMALS_UNVERIFIED}. Sign in to your local owner workspace with the control service running.</p> : null}
      <div className="grid-3">
        {amountField("maxPayment", "Max single payment")}
        {amountField("perTask", "Per-task cap")}
        {amountField("perAgent", "Per-agent cap")}
        <div className="field">
          <label htmlFor={`${id}-period`}>Period (hours) *</label>
          <input id={`${id}-period`} required inputMode="numeric" value={f.periodHours} onChange={(e) => setF({ ...f, periodHours: e.target.value })} aria-invalid={hoursOk ? undefined : true} />
          <span className="hint">1–8760</span>
        </div>
      </div>
      {nestError ? (
        <p className="notice notice-error small" role="alert">
          {nestError}
        </p>
      ) : null}
      <fieldset>
        <legend>Allowed listings</legend>
        {catalogue.loading && !catalogue.data ? <Loading label="listings" /> : null}
        <ErrorNotice error={catalogue.error} what="listings could not be loaded" onRetry={catalogue.reload} />
        {catalogue.data && catalogue.data.listings.length === 0 ? <p className="small muted">No published listings to allow.</p> : null}
        <div className="checks checks-column">
          {catalogue.data?.listings.map((l) => (
            <label key={l.listing_id}>
              <input type="checkbox" checked={allowed.includes(l.listing_id)} onChange={(e) => setAllowed(e.target.checked ? [...allowed, l.listing_id] : allowed.filter((x) => x !== l.listing_id))} />{" "}
              {l.title} <span className="small muted">by {l.seller_name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="small">This proposal is inactive until your local controller acknowledges it. The local controller enforces its own limits regardless.</p>
      <button type="submit" className="btn btn-primary" disabled={!m.canAct || action.busy || !allOk || nestError !== null || !hoursOk}>
        Propose policy
      </button>
      <ErrorNotice error={action.error} what="policy not proposed" />
    </form>
  );
}
