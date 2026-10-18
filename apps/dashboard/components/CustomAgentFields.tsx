"use client";

import { Icon } from "./Icon";
import Link from "next/link";
import { useId, useState } from "react";
import { SPECIALIST_SKU } from "@veilo/contracts/marketplace";
import { api } from "../lib/api";
import { formatUnits, parseUnits } from "../lib/market/amounts";
import { marketApi } from "../lib/market/client";
import { DECIMALS_UNVERIFIED, OFFER_DRAFT_KEY } from "../lib/market/messages";
import type { CatalogEntry } from "../lib/market/types";
import { AGENT_TEMPLATES, type Agent, type AgentTemplate } from "../lib/types";
import type { AgentPolicyInput } from "./Policy";
import { useCapability } from "./Shell";
import { useAction, useResource } from "./hooks";
import { AgentGrants } from "./market/LocalApproval";
import { EnsureMarket, useMarket } from "./market/MarketContext";
import { PlainText } from "./market/parts";
import { DeniedHint, ErrorNotice, KV, Loading, Section } from "./ui";
import { Select } from "./Select";

/** Server limits from the control contracts (createAgentRequestSchema, runAgentRequestSchema, customTaskInputSchema). */
export const CUSTOM_INSTRUCTIONS_MAX = 8_000;
export const CUSTOM_OBJECTIVE_MAX = 4_000;
const CUSTOM_CONTEXT_MAX = 8_000;
const CUSTOM_SEARCH_MAX = 200;

export const TEMPLATE_LABEL: Record<AgentTemplate, string> = {
  generalist: "Generalist",
  researcher: "Researcher",
  writer: "Writer",
  analyst: "Analyst",
};

export interface GrantDraft {
  listingId: string;
  recipient: string;
  maxTotalUnits: string;
  title: string;
}

export interface CustomDraft {
  template: AgentTemplate;
  instructions: string;
  hiring: boolean;
  grants: GrantDraft[];
}

export const EMPTY_CUSTOM: CustomDraft = { template: "generalist", instructions: "", hiring: false, grants: [] };

export const hiringAllowed = (skus: readonly string[] | undefined): boolean => (skus ?? []).includes(SPECIALIST_SKU);

/** A marketplace hire is paid as the specialist SKU over the private path, so hiring is exactly that permission. */
export function withHiring(p: AgentPolicyInput, on: boolean): AgentPolicyInput {
  const skus = p.allowedSkus.filter((s) => s !== SPECIALIST_SKU);
  const paths: AgentPolicyInput["allowedPaymentPaths"] = on && !p.allowedPaymentPaths.includes("private_x402") ? [...p.allowedPaymentPaths, "private_x402"] : p.allowedPaymentPaths;
  return { ...p, allowedSkus: on ? [...skus, SPECIALIST_SKU] : skus, allowedPaymentPaths: paths };
}

export const grantBody = (g: Pick<GrantDraft, "listingId" | "recipient" | "maxTotalUnits">) => ({ listingId: g.listingId, recipient: g.recipient, maxTotalUnits: g.maxTotalUnits });

const TEMPLATE_OPTIONS = AGENT_TEMPLATES.map((t) => ({ value: t, label: TEMPLATE_LABEL[t] }));

/** Shown wherever a task for a dashboard-created agent could otherwise look stuck. */
export function RunnerCredentialNote() {
  return (
    <p className="notice notice-warn small" role="note">
      Tasks run only when the local runner holds a worker credential for this agent, and the dashboard never issues one. For an agent created here, run{" "}
      <code>pnpm demo:seed</code> (it adds credentials for agents that have none and keeps existing ones), then restart the runner. Until then its tasks stay
      queued.
    </p>
  );
}

function HiringCopy() {
  return (
    <p className="small">
      Each hire waits for your OK in <Link href="/marketplace/approvals">Approvals</Link>, unless it matches a listing you pre-approve below. It always stays within this agent&apos;s limits.
    </p>
  );
}

/** Create-time fields for a custom agent: template, instructions and the marketplace hiring opt-in. */
export function CustomAgentFields({ value, onChange }: { value: CustomDraft; onChange: (v: CustomDraft) => void }) {
  const ids = { template: useId(), instructions: useId(), hiring: useId() };
  return (
    <fieldset>
      <legend>Custom agent</legend>
      <div className="field">
        <label htmlFor={ids.template}>Starting template</label>
        <Select id={ids.template} label="Starting template" value={value.template} options={TEMPLATE_OPTIONS} onChange={(t) => onChange({ ...value, template: t })} />
      </div>
      <div className="field">
        <label htmlFor={ids.instructions}>Instructions *</label>
        <textarea
          id={ids.instructions}
          required
          rows={5}
          maxLength={CUSTOM_INSTRUCTIONS_MAX}
          value={value.instructions}
          onChange={(e) => onChange({ ...value, instructions: e.target.value })}
          aria-describedby={`${ids.instructions}-h`}
        />
        <span id={`${ids.instructions}-h`} className="hint">
          What this agent does and how. It can&apos;t change its own limits or see your keys.
        </span>
      </div>
      <fieldset>
        <legend>Marketplace hiring</legend>
        <div className="field inline">
          <input id={ids.hiring} type="checkbox" checked={value.hiring} onChange={(e) => onChange({ ...value, hiring: e.target.checked, grants: e.target.checked ? value.grants : [] })} />
          <label htmlFor={ids.hiring}>Allow this agent to hire specialists from the marketplace</label>
        </div>
        <HiringCopy />
        {value.hiring ? (
          <EnsureMarket>
            <GrantDraftPicker grants={value.grants} onChange={(grants) => onChange({ ...value, grants })} />
          </EnsureMarket>
        ) : null}
      </fieldset>
    </fieldset>
  );
}

/** Optional pre-approved listings, saved to the agent's allowlist after it is created. */
function GrantDraftPicker({ grants, onChange }: { grants: GrantDraft[]; onChange: (g: GrantDraft[]) => void }) {
  const m = useMarket();
  const catalogue = useResource(() => (m.configured ? marketApi<{ listings: CatalogEntry[] }>("/marketplace/listings?limit=50") : Promise.resolve({ listings: [] as CatalogEntry[] })), "create-grant-catalogue");
  const [listingId, setListingId] = useState("");
  const [max, setMax] = useState("");
  const ids = { listing: useId(), max: useId() };
  const decimals = m.token?.decimals ?? null;
  const parsed = decimals === null ? null : parseUnits(max, decimals);
  const chosen = catalogue.data?.listings.find((l) => l.listing_id === listingId);
  if (!m.configured) return <p className="small muted">The marketplace is not configured for this dashboard, so no listing can be pre-approved now. Hires will wait for your approval.</p>;
  return (
    <div>
      <h4>Pre-approved listings (optional)</h4>
      <p className="small">A pre-approved listing is paid without asking you, up to the maximum you set here. Leave this empty to approve every hire yourself.</p>
      {catalogue.loading && !catalogue.data ? <Loading label="listings" /> : null}
      <ErrorNotice error={catalogue.error} what="listings could not be loaded" onRetry={catalogue.reload} />
      {grants.length > 0 ? (
        <ul className="plain">
          {grants.map((g) => (
            <li key={g.listingId} className="version">
              {g.title} · up to {decimals === null ? `${g.maxTotalUnits} base units` : `${formatUnits(g.maxTotalUnits, decimals)} USDC`}{" "}
              <button type="button" className="btn btn-small" onClick={() => onChange(grants.filter((x) => x.listingId !== g.listingId))}>
                Remove {g.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid-2">
        <div className="field">
          <label htmlFor={ids.listing}>Listing</label>
          <Select
            id={ids.listing}
            label="Listing"
            value={listingId}
            options={[{ value: "", label: "Choose a published listing" }, ...(catalogue.data?.listings ?? []).map((l) => ({ value: l.listing_id, label: `${l.title} — ${l.seller_name}` }))]}
            onChange={setListingId}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.max}>Maximum total per hire</label>
          <input id={ids.max} inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} disabled={decimals === null} aria-describedby={`${ids.max}-h`} />
          <span id={`${ids.max}-h`} className={max && parsed && !parsed.ok ? "hint field-error" : "hint"}>
            {decimals === null ? `Amount entry disabled: ${DECIMALS_UNVERIFIED}.` : max && parsed && !parsed.ok ? parsed.error : "Test tokens; the recipient is pinned to the listing's payout wallet."}
          </span>
        </div>
      </div>
      <button
        type="button"
        className="btn"
        disabled={!chosen || !parsed?.ok || parsed.value === "0"}
        onClick={() => {
          if (!chosen || !parsed?.ok) return;
          onChange([...grants.filter((g) => g.listingId !== chosen.listing_id), { listingId: chosen.listing_id, recipient: chosen.recipient, maxTotalUnits: parsed.value, title: chosen.title }]);
          setListingId("");
          setMax("");
        }}
      >
        Pre-approve listing
      </button>
    </div>
  );
}

/** Custom agent job: the objective plus optional context and search terms; instructions come from the agent record. */
export function CustomRunForm({ agent, disabled, onQueued }: { agent: Agent; disabled: boolean; onQueued: () => void | Promise<void> }) {
  const run = useCapability("run");
  const [objective, setObjective] = useState("");
  const [context, setContext] = useState("");
  const [search, setSearch] = useState("");
  const action = useAction();
  const ids = { objective: useId(), context: useId(), search: useId() };
  const off = disabled || action.busy;
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (off || objective.trim() === "") return;
        void action.run(async () => {
          const input: Record<string, string> = {};
          if (context.trim()) input.context = context.trim();
          if (search.trim()) input.searchQuery = search.trim();
          await api<{ taskId: string; executor: string }>("control", `/agents/${agent.id}/run`, {
            method: "POST",
            body: { objective: objective.trim(), ...(Object.keys(input).length > 0 ? { input } : {}) },
          });
          setObjective("");
          await onQueued();
        });
      }}
    >
      <div className="composer-box">
        <label htmlFor={ids.objective} className="sr-only">
          Message {agent.name}
        </label>
        <textarea
          id={ids.objective}
          rows={1}
          maxLength={CUSTOM_OBJECTIVE_MAX}
          value={objective}
          disabled={off}
          placeholder={!run.allowed ? (run.reason ?? "") : disabled ? `${agent.name} can't take jobs right now` : `Message ${agent.name}…`}
          onChange={(e) => setObjective(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" className="send-btn" aria-label="Send job" disabled={off || objective.trim() === ""}>
          <Icon name="send" />
        </button>
      </div>
      <details className="composer-more">
        <summary>More options</summary>
        <div className="field">
          <label htmlFor={ids.context}>Extra context</label>
          <textarea id={ids.context} rows={3} maxLength={CUSTOM_CONTEXT_MAX} value={context} onChange={(e) => setContext(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.search}>Marketplace search words</label>
          <input id={ids.search} maxLength={CUSTOM_SEARCH_MAX} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </details>
      {!run.allowed ? <DeniedHint reason={run.reason} /> : null}
      <ErrorNotice error={action.error} />
    </form>
  );
}

function InstructionsEditor({ agent, onSaved }: { agent: Agent; onSaved: () => Promise<void> }) {
  const [template, setTemplate] = useState<AgentTemplate>(agent.template ?? "generalist");
  const [instructions, setInstructions] = useState(agent.instructions ?? "");
  const save = useAction();
  const ids = { template: useId(), instructions: useId() };
  const changed = template !== agent.template || instructions.trim() !== (agent.instructions ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(async () => {
          const body: Record<string, string> = {};
          if (template !== agent.template) body.template = template;
          if (instructions.trim() !== (agent.instructions ?? "")) body.instructions = instructions.trim();
          await api("control", `/agents/${agent.id}/config`, { method: "PATCH", body });
          await onSaved();
        });
      }}
    >
      <h3>Edit instructions</h3>
      <div className="field">
        <label htmlFor={ids.template}>Template</label>
        <Select id={ids.template} label="Template" value={template} options={TEMPLATE_OPTIONS} onChange={setTemplate} />
      </div>
      <div className="field">
        <label htmlFor={ids.instructions}>Instructions</label>
        <textarea id={ids.instructions} rows={5} maxLength={CUSTOM_INSTRUCTIONS_MAX} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </div>
      <p className="small">Changes apply to jobs started after saving; queued jobs keep the instructions they were started with.</p>
      <button type="submit" className="btn btn-primary" disabled={save.busy || !changed || instructions.trim() === ""}>
        Save instructions
      </button>
      <ErrorNotice error={save.error} />
    </form>
  );
}

/** Agent page sections for a custom agent: instructions, job form, marketplace hiring and selling. */
export function CustomAgentPanel({
  agent,
  policy,
  canRun,
  terminal,
  onChanged,
  part = "all",
}: {
  agent: Agent;
  policy: AgentPolicyInput | null;
  canRun: boolean;
  terminal: boolean;
  onChanged: () => Promise<void>;
  /** "composer" is the job form under the thread; "details" is everything else, for the side column. */
  part?: "all" | "composer" | "details";
}) {
  const toggle = useAction();
  const run = useCapability("run");
  const configure = useCapability("configure");
  const editable = !terminal && configure.allowed;
  const hiring = hiringAllowed(agent.activePolicy?.permissions?.allowedSkus);
  const composer = <CustomRunForm agent={agent} disabled={!canRun || !run.allowed} onQueued={onChanged} />;
  if (part === "composer") return composer;
  return (
    <>
      <Section title="Instructions" id="instructions">
        <KV
          rows={[
            ["Template", agent.template ? TEMPLATE_LABEL[agent.template] : "—"],
            ["Instructions", <PlainText key="i" text={agent.instructions ?? "—"} />],
          ]}
        />
        {editable ? <InstructionsEditor agent={agent} onSaved={onChanged} /> : null}
      </Section>
      {part === "all" ? composer : null}
      <details className="advanced">
        <summary>Running it locally</summary>
        <RunnerCredentialNote />
      </details>
      <Section title="Offer on the marketplace">
        <p>List these instructions as a specialist that other workspaces can hire and pay you for.</p>
        <p className="small muted">
          Buyers&apos; jobs run on the marketplace&apos;s managed runtime with these instructions. They don&apos;t use this agent&apos;s connectors, your model key or your private pool.
        </p>
        <Link
          className="btn"
          href="/marketplace/seller"
          onClick={() => {
            try {
              sessionStorage.setItem(OFFER_DRAFT_KEY, JSON.stringify({ title: agent.name, sellerInstructions: agent.instructions ?? "" }));
            } catch {
              // Without storage the seller form simply starts empty.
            }
          }}
        >
          Create a listing
        </Link>
      </Section>
      <Section title="Marketplace hiring">
        <p>
          Hiring is <strong>{hiring ? "allowed" : "off"}</strong> in the active policy.
        </p>
        <HiringCopy />
        {policy && editable ? (
          <button
            type="button"
            className="btn"
            disabled={toggle.busy}
            onClick={() =>
              void toggle.run(async () => {
                await api("control", `/agents/${agent.id}/config`, { method: "PATCH", body: { policy: withHiring(policy, !hiring) } });
                await onChanged();
              })
            }
          >
            {hiring ? "Draft a policy without hiring" : "Draft a policy that allows hiring"}
          </button>
        ) : null}
        <p className="small">The change is saved as a policy draft; it takes effect only after you activate it under Settings below.</p>
        <ErrorNotice error={toggle.error} />
        {!terminal && !configure.allowed ? <DeniedHint reason={configure.reason} /> : null}
        {hiring && editable ? (
          <EnsureMarket>
            <AgentGrants agentId={agent.id} name={`Pre-approved listings for ${agent.name}`} />
          </EnsureMarket>
        ) : null}
      </Section>
      <Section title="Offer on the marketplace">
        <p className="small">
          A workspace agent cannot be listed on the marketplace yet. Listings run on a managed template or on your own seller host, set up in the{" "}
          <Link href="/marketplace/seller">seller console</Link>.
        </p>
      </Section>
    </>
  );
}
