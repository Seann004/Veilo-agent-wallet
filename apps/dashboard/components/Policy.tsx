"use client";

import { useId, useState } from "react";
import { credits, formatBaseUnits, parseUsdcInput, trimFraction, usdc } from "../lib/format";
import type { AgentRole, Policy, Workspace } from "../lib/types";
import { Icon } from "./Icon";
import { Select, type SelectOption } from "./Select";
import { KV } from "./ui";

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
}

export const ROLE_TEMPLATES: Record<AgentRole, { name: string; description: string; trigger: Record<string, string | number>; policy: AgentPolicyInput }> = {
  credit_manager: {
    name: "Shawn",
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
    name: "Prince",
    description: "Answer owner research questions with purchased, cited evidence.",
    trigger: { type: "owner_task" },
    policy: {
      tier: "bounded_automatic",
      lifetimeTestUsdc: "2000000",
      rolling24hTestUsdc: "2000000",
      maxPurchaseTestUsdc: "500000",
      taskLimitTestUsdc: "1000000",
      usageAllowanceUnits: "2000000",
      taskCreditUnits: "400000",
      allowedSkus: ["research-basic", "research-expanded", "summarize", "analyze"],
      allowedPaymentPaths: ["private_x402", "prepaid_credits"],
    },
  },
  content: {
    name: "Mira",
    description: "Turn campaign briefs and approved research into editable drafts and a seven-day calendar.",
    trigger: { type: "owner_task" },
    policy: {
      tier: "bounded_automatic",
      lifetimeTestUsdc: "2000000",
      rolling24hTestUsdc: "2000000",
      maxPurchaseTestUsdc: "500000",
      taskLimitTestUsdc: "1000000",
      usageAllowanceUnits: "2000000",
      taskCreditUnits: "400000",
      allowedSkus: ["content-package", "summarize", "analyze"],
      allowedPaymentPaths: ["private_x402", "prepaid_credits"],
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
      <span id={`${id}-h`} className="hint">
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
const skuLabel = (sku: string) => sku.charAt(0).toUpperCase() + sku.slice(1).replace(/-/g, " ");

export const TIER_OPTIONS: Array<SelectOption<AgentPolicyInput["tier"]>> = [
  { value: "bounded_automatic", label: "Automatically, within limits", hint: "Buys what a task needs, up to your limits" },
  { value: "approval_required", label: "Needs approval", hint: "Each purchase waits for you" },
  { value: "observe", label: "Plan only", hint: "Plans tasks but never buys" },
  { value: "stopped", label: "Stopped", hint: "No new work; open payments still settle" },
];

const PATH_LABEL: Record<AgentPolicyInput["allowedPaymentPaths"][number], string> = {
  private_x402: "Private pool (USDC)",
  prepaid_credits: "Prepaid credits",
};

/**
 * Structured policy editor. Amounts are typed in test-USDC and converted to base units without
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
  const [paths, setPaths] = useState(initial.allowedPaymentPaths);
  const allSkus = [...new Set(workspace.services.flatMap((s) => s.skus.map((k) => k.sku)))].sort();
  const tierId = useId();

  const emit = (next: Partial<typeof text>, nextTier = tier, nextSkus = skus, nextPaths = paths) => {
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
    });
  };
  const toggleSku = (sku: string) => {
    const next = skus.includes(sku) ? skus.filter((x) => x !== sku) : [...skus, sku];
    setSkus(next);
    emit({}, tier, next);
  };
  const togglePath = (p: AgentPolicyInput["allowedPaymentPaths"][number]) => {
    const next = paths.includes(p) ? paths.filter((x) => x !== p) : [...paths, p];
    setPaths(next);
    emit({}, tier, skus, next);
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
          {allSkus.map((sku) => (
            <ChipToggle key={sku} label={skuLabel(sku)} on={skus.includes(sku)} onToggle={() => toggleSku(sku)} />
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">How it pays</span>
        <div className="chips" role="group" aria-label="How it pays">
          {(["private_x402", "prepaid_credits"] as const).map((p) => (
            <ChipToggle key={p} label={PATH_LABEL[p]} on={paths.includes(p)} onToggle={() => togglePath(p)} />
          ))}
        </div>
      </div>
      <details className="advanced">
        <summary>Advanced: AI credits</summary>
        <div className="money-grid">
          <MoneyField label="Credit allowance" hint="Total, in microcredits" unit="µcr" inputMode="numeric" value={text.usage} onChange={(v) => emit({ usage: v })} />
          <MoneyField label="Credits per task" hint="Per task, in microcredits" unit="µcr" inputMode="numeric" value={text.taskCredits} onChange={(v) => emit({ taskCredits: v })} />
        </div>
      </details>
    </div>
  );
}

/** Effective policy: the agent's limits shown next to the workspace limits that also apply. */
export function PolicyReview({ policy, workspacePolicy, title }: { policy: Policy | AgentPolicyInput; workspacePolicy: Policy | undefined; title: string }) {
  const p = policy as Partial<Policy> & Partial<AgentPolicyInput>;
  const skus = p.permissions?.allowedSkus ?? p.allowedSkus ?? [];
  const paths = p.permissions?.allowedPaymentPaths ?? p.allowedPaymentPaths ?? [];
  const role = (p.roleConfig ?? null) as AgentPolicyInput["roleConfig"] | null;
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
            ["Pays with", paths.length ? paths.map((x) => PATH_LABEL[x as keyof typeof PATH_LABEL] ?? x).join(", ") : "Nothing"],
            ["AI credits", `${credits(p.usageAllowanceUnits)} · ${credits(p.taskCreditUnits)} per task`],
            ...(role
              ? [["Top-up rule", `Buy ${credits(role.creditPackUnits)} when below ${credits(role.creditLowWatermark)}; checks every ${role.pollSeconds} s`] as [string, string]]
              : []),
          ]}
        />
      </div>
    );
}
