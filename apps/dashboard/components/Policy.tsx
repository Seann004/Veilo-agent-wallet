"use client";

import { useId, useState } from "react";
import { credits, formatBaseUnits, parseUsdcInput, trimFraction, usdc } from "../lib/format";
import type { AgentRole, Policy, Workspace } from "../lib/types";
import { Icon } from "./Icon";
import { Select, type SelectOption } from "./Select";
import { KV } from "./ui";
import { HIDDEN_SKUS, skuGroup, skuLabel } from "../lib/labels";

/** Agent policy body accepted by the control service (base-unit decimal strings). */
export interface AgentPolicyInput {
  tier: "observe" | "bounded_automatic" | "approval_required" | "stopped";
  lifetimeTestUsdc: string;
  rolling24hTestUsdc: string;
  maxPurchaseTestUsdc: string;
  taskLimitTestUsdc: string;
  usageAllowanceUnits: string;
  taskCreditUnits: string;
  allowedSkus: string[];
  allowedPaymentPaths: Array<"private_x402" | "prepaid_credits">;
  roleConfig?: { creditLowWatermark: string; creditPackUnits: string; pollSeconds: number; cooldownSeconds: number };
  /** Read-only web browsing; off unless the owner turns it on. */
  allowBrowsing?: boolean;
}

export const ROLE_TEMPLATES: Record<AgentRole, { name: string; description: string; trigger: Record<string, string | number>; policy: AgentPolicyInput }> = {
  credit_manager: {
    name: "Credit manager",
    description: "Keep shared gateway inference credits above the threshold by buying one credit pack at a time.",
    trigger: { type: "low_credit_balance", pollSeconds: 60 },
    policy: {
      tier: "bounded_automatic",
      lifetimeTestUsdc: "3000000",
      rolling24hTestUsdc: "3000000",
      maxPurchaseTestUsdc: "1000000",
      taskLimitTestUsdc: "1000000",
      usageAllowanceUnits: "0",
      taskCreditUnits: "0",
      allowedSkus: ["inference-credit-pack"],
      allowedPaymentPaths: ["private_x402"],
      roleConfig: { creditLowWatermark: "200000", creditPackUnits: "1000000", pollSeconds: 60, cooldownSeconds: 600 },
    },
  },
  research: {
    name: "Research agent",
    description: "Answer owner research questions with purchased, cited evidence.",
    trigger: { type: "owner_task" },
    policy: {
      tier: "bounded_automatic",
      lifetimeTestUsdc: "2000000",
      rolling24hTestUsdc: "2000000",
      maxPurchaseTestUsdc: "500000",
      taskLimitTestUsdc: "1000000",
      usageAllowanceUnits: "0",
      taskCreditUnits: "0",
      allowedSkus: ["research-basic", "research-expanded"],
      allowedPaymentPaths: ["private_x402"],
    },
  },
  content: {
    name: "Content agent",
    description: "Turn campaign briefs and approved research into editable drafts and a seven-day calendar.",
    trigger: { type: "owner_task" },
    policy: {
      tier: "bounded_automatic",
      lifetimeTestUsdc: "2000000",
      rolling24hTestUsdc: "2000000",
      maxPurchaseTestUsdc: "500000",
      taskLimitTestUsdc: "1000000",
      usageAllowanceUnits: "0",
      taskCreditUnits: "0",
      allowedSkus: [],
      allowedPaymentPaths: ["private_x402"],
    },
  },
  custom: {
    name: "Custom agent",
    description: "Follows your instructions, using its connectors and your AI model to do the work itself. It may propose a marketplace specialist, but pays nobody without your approval.",
    trigger: { type: "owner_task" },
    // Its own work runs on the owner's model key; the specialist SKU is added only when the owner opts in to hiring.
    policy: {
      tier: "bounded_automatic",
      lifetimeTestUsdc: "2000000",
      rolling24hTestUsdc: "2000000",
      maxPurchaseTestUsdc: "500000",
      taskLimitTestUsdc: "1000000",
      usageAllowanceUnits: "0",
      taskCreditUnits: "0",
      allowedSkus: [],
      allowedPaymentPaths: ["private_x402"],
    },
  },
};

function MoneyField({ label, hint, value, onChange, unit = "USDC", inputMode = "decimal" }: { label: string; hint: string; value: string; onChange: (v: string) => void; unit?: string; inputMode?: "decimal" | "numeric" }) {
  const id = useId();
  return (
    <div className="field money-field">
      <label htmlFor={id}>{label}</label>
      <span className="input-unit">
        <input id={id} value={value} inputMode={inputMode} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-h`} />
        <span aria-hidden="true">{unit}</span>
      </span>
      <span id={`${id}-h`} className="sr-only">
        {hint}
      </span>
    </div>
  );
}

function ChipToggle({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="chip chip-toggle" aria-pressed={on} onClick={onToggle}>
      {on ? <Icon name="check" size={14} /> : null}
      {label}
    </button>
  );
}

const usdcText = (base: string) => trimFraction(formatBaseUnits(base, 6).replace(/,/g, ""));

export const TIER_OPTIONS: Array<SelectOption<AgentPolicyInput["tier"]>> = [
  { value: "bounded_automatic", label: "Automatically, within limits", hint: "Buys what a task needs, up to your limits" },
  { value: "approval_required", label: "Needs approval", hint: "Each purchase waits for you" },
  { value: "observe", label: "Plan only", hint: "Plans tasks but never buys" },
  { value: "stopped", label: "Stopped", hint: "No new work; open payments still settle" },
];

const PATH_LABEL: Record<AgentPolicyInput["allowedPaymentPaths"][number], string> = {
  private_x402: "USDC from the private pool",
  prepaid_credits: "AI credits",
};


/**
 * Structured policy editor. Amounts are typed in USDC and converted to base units without
 * floats; invalid amounts block submission instead of being rounded.
 */
export function PolicyForm({ initial, workspace, onChange }: { initial: AgentPolicyInput; workspace: Workspace; onChange: (p: AgentPolicyInput | null) => void }) {
  const [text, setText] = useState({
    lifetime: usdcText(initial.lifetimeTestUsdc),
    rolling: usdcText(initial.rolling24hTestUsdc),
    maxPurchase: usdcText(initial.maxPurchaseTestUsdc),
    task: usdcText(initial.taskLimitTestUsdc),
    usage: initial.usageAllowanceUnits,
    taskCredits: initial.taskCreditUnits,
  });
  const [tier, setTier] = useState(initial.tier);
  const [skus, setSkus] = useState<string[]>(initial.allowedSkus);
  const paths = initial.allowedPaymentPaths;
  const [browse, setBrowse] = useState(initial.allowBrowsing === true);
  const allSkus = [...new Set(workspace.services.flatMap((s) => s.skus.map((k) => k.sku)))].filter((k) => !HIDDEN_SKUS.has(k)).sort();
  const [pickSkus, setPickSkus] = useState(() => !allSkus.every((k) => initial.allowedSkus.includes(k)));
  const groups = [...new Set(allSkus.map(skuGroup))];
  const tierId = useId();
  const browseId = useId();

  const emit = (next: Partial<typeof text>, nextTier = tier, nextSkus = skus, nextPaths = paths, nextBrowse = browse) => {
    const t = { ...text, ...next };
    setText(t);
    const vals = [parseUsdcInput(t.lifetime), parseUsdcInput(t.rolling), parseUsdcInput(t.maxPurchase), parseUsdcInput(t.task)];
    const units = /^(0|[1-9][0-9]{0,17})$/;
    if (vals.some((v) => v === null) || !units.test(t.usage) || !units.test(t.taskCredits)) return onChange(null);
    onChange({
      ...initial,
      tier: nextTier,
      lifetimeTestUsdc: vals[0]!,
      rolling24hTestUsdc: vals[1]!,
      maxPurchaseTestUsdc: vals[2]!,
      taskLimitTestUsdc: vals[3]!,
      usageAllowanceUnits: t.usage,
      taskCreditUnits: t.taskCredits,
      allowedSkus: nextSkus,
      allowedPaymentPaths: nextPaths,
      allowBrowsing: nextBrowse,
    });
  };
  const toggleSku = (sku: string) => {
    const next = skus.includes(sku) ? skus.filter((x) => x !== sku) : [...skus, sku];
    setSkus(next);
    emit({}, tier, next);
  };

  return (
    <div className="policy-form">
      <div className="field">
        <label htmlFor={tierId}>How it spends</label>
        <Select
          id={tierId}
          label="How it spends"
          value={tier}
          options={TIER_OPTIONS}
          onChange={(v) => {
            setTier(v);
            emit({}, v);
          }}
        />
      </div>
      <div className="money-grid">
        <MoneyField label="Total budget" hint="Over the agent's lifetime" value={text.lifetime} onChange={(v) => emit({ lifetime: v })} />
        <MoneyField label="Per day" hint="In any 24 hours" value={text.rolling} onChange={(v) => emit({ rolling: v })} />
        <MoneyField label="Per purchase" hint="Most it pays for one item" value={text.maxPurchase} onChange={(v) => emit({ maxPurchase: v })} />
        <MoneyField label="Per task" hint="Most one task can spend" value={text.task} onChange={(v) => emit({ task: v })} />
      </div>
      <div className="field">
        <span className="field-label">What it can buy</span>
        <div className="chips" role="group" aria-label="What it can buy">
          <ChipToggle
            label="Anything approved"
            on={!pickSkus}
            onToggle={() => {
              setPickSkus(false);
              setSkus(allSkus);
              emit({}, tier, allSkus);
            }}
          />
          <ChipToggle label="Only what I pick" on={pickSkus} onToggle={() => setPickSkus(true)} />
        </div>
        {pickSkus ? (
          <div className="sku-groups">
            {groups.map((g) => (
              <div key={g} className="sku-group">
                <span className="small muted">{g}</span>
                <div className="chips" role="group" aria-label={g}>
                  {allSkus
                    .filter((k) => skuGroup(k) === g)
                    .map((sku) => (
                      <ChipToggle key={sku} label={skuLabel(sku)} on={skus.includes(sku)} onToggle={() => toggleSku(sku)} />
                    ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <span className="hint">{groups.join(", ")}: everything approved in this workspace today.</span>
        )}
      </div>
      <div className="field inline">
        <input
          id={browseId}
          type="checkbox"
          checked={browse}
          onChange={(e) => {
            setBrowse(e.target.checked);
            emit({}, tier, skus, paths, e.target.checked);
          }}
        />
        <label htmlFor={browseId}>
          Can read web pages <span className="muted">(up to 3 per task, read-only)</span>
        </label>
      </div>
    </div>
  );
}

/** Effective policy: the agent's limits shown next to the workspace limits that also apply. */
export function PolicyReview({ policy, workspacePolicy, title }: { policy: Policy | AgentPolicyInput; workspacePolicy: Policy | undefined; title: string }) {
  const p = policy as Partial<Policy> & Partial<AgentPolicyInput>;
  const skus = p.permissions?.allowedSkus ?? p.allowedSkus ?? [];
  const paths = p.permissions?.allowedPaymentPaths ?? p.allowedPaymentPaths ?? [];
  const role = p.roleConfig;
  const topUp = role && typeof role.creditPackUnits === "string" && /^\d+$/.test(role.creditPackUnits)
    && typeof role.creditLowWatermark === "string" && /^\d+$/.test(role.creditLowWatermark)
    && typeof role.pollSeconds === "number" && Number.isSafeInteger(role.pollSeconds) && role.pollSeconds > 0
    ? `Buy ${credits(role.creditPackUnits)} when below ${credits(role.creditLowWatermark)}; checks every ${role.pollSeconds} s`
    : null;
    const ws = (v: string | null | undefined) => (workspacePolicy ? <span className="muted"> · workspace cap {usdc(v)}</span> : null);
    return (
      <div className="policy-compact">
        <h3>{title}</h3>
        <KV
          rows={[
            ["Spends", TIER_OPTIONS.find((t) => t.value === p.tier)?.label ?? String(p.tier)],
            ["Per purchase", usdc(p.maxPurchaseTestUsdc)],
            ["Per task", usdc(p.taskLimitTestUsdc)],
            ["Per day", <>{usdc(p.rolling24hTestUsdc)}{ws(workspacePolicy?.rolling24hTestUsdc)}</>],
            ["Total budget", <>{usdc(p.lifetimeTestUsdc)}{ws(workspacePolicy?.lifetimeTestUsdc)}</>],
            ["Can buy", skus.length ? skus.map(skuLabel).join(", ") : "Nothing"],
            ["Web browsing", (p.permissions as { allowBrowsing?: boolean } | undefined)?.allowBrowsing ?? p.allowBrowsing ? "On (read-only)" : "Off"],
            ["Pays with", paths.length ? paths.map((x) => PATH_LABEL[x as keyof typeof PATH_LABEL] ?? x).join(", ") : "Nothing"],
            ...(topUp
              ? [["Top-up rule", topUp] as [string, string]]
              : []),
          ]}
        />
      </div>
    );
}

/** Review summary for a new agent: the same facts as PolicyReview, grouped into short sections. */
export function PolicyReviewGroups({
  policy,
  workspacePolicy,
  title,
  hiring,
}: {
  policy: Policy | AgentPolicyInput;
  workspacePolicy: Policy | undefined;
  title: string;
  hiring?: { allowed: boolean; grants: number } | null;
}) {
  const p = policy as Partial<Policy> & Partial<AgentPolicyInput>;
  const skus = p.permissions?.allowedSkus ?? p.allowedSkus ?? [];
  const paths = p.permissions?.allowedPaymentPaths ?? p.allowedPaymentPaths ?? [];
  const browsing = (p.permissions as { allowBrowsing?: boolean } | undefined)?.allowBrowsing ?? p.allowBrowsing;
  const cap = (v: string | null | undefined) => (workspacePolicy ? <span className="muted"> · workspace cap {usdc(v)}</span> : null);
  const role = p.roleConfig;
  const topUp = role && typeof role.creditPackUnits === "string" && /^\d+$/.test(role.creditPackUnits)
    && typeof role.creditLowWatermark === "string" && /^\d+$/.test(role.creditLowWatermark)
    && typeof role.pollSeconds === "number" && Number.isSafeInteger(role.pollSeconds) && role.pollSeconds > 0
    ? `Buy ${credits(role.creditPackUnits)} when below ${credits(role.creditLowWatermark)}; checks every ${role.pollSeconds} s`
    : null;
  return (
    <div className="review-groups">
      <h3>{title}</h3>
      <div className="review-grid">
        <section className="review-group" aria-label="Spending">
          <h4>Spending</h4>
          <KV
            rows={[
              ["Spends", TIER_OPTIONS.find((t) => t.value === p.tier)?.label ?? String(p.tier)],
              ["Per purchase", usdc(p.maxPurchaseTestUsdc)],
              ["Per task", usdc(p.taskLimitTestUsdc)],
              ["Per day", <>{usdc(p.rolling24hTestUsdc)}{cap(workspacePolicy?.rolling24hTestUsdc)}</>],
              ["Total budget", <>{usdc(p.lifetimeTestUsdc)}{cap(workspacePolicy?.lifetimeTestUsdc)}</>],
              ...(topUp ? [["Top-up rule", topUp] as [string, string]] : []),
            ]}
          />
        </section>
        <div className="review-col">
          <section className="review-group" aria-label="Can buy">
            <h4>Can buy</h4>
            {skus.length ? (
              <ul className="review-chips">
                {skus.map((s) => (
                  <li key={s} className="pill pill-muted">{skuLabel(s)}</li>
                ))}
              </ul>
            ) : (
              <p className="small muted">Nothing</p>
            )}
          </section>
          <section className="review-group" aria-label="Access">
            <h4>Access</h4>
            <KV
              rows={[
                ["Web browsing", browsing ? "On (read-only)" : "Off"],
                ...(hiring ? ([["Marketplace hiring", hiring.allowed ? `Allowed · ${hiring.grants} pre-approved listing${hiring.grants === 1 ? "" : "s"}` : "Off"]] as Array<[string, string]>) : []),
                ["Pays with", paths.length ? paths.map((x) => PATH_LABEL[x as keyof typeof PATH_LABEL] ?? x).join(", ") : "Nothing"],
              ]}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
