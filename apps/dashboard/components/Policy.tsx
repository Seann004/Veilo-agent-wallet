"use client";

import { useId, useState } from "react";
import { credits, parseUsdcInput, usdc, formatBaseUnits } from "../lib/format";
import type { AgentRole, Policy, Workspace } from "../lib/types";
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

function Field({ label, value, onChange, hint, inputMode }: { label: string; value: string; onChange: (v: string) => void; hint?: string; inputMode?: "decimal" | "numeric" }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} inputMode={inputMode} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-h` : undefined} />
      {hint ? (
        <span id={`${id}-h`} className="hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

const usdcText = (base: string) => formatBaseUnits(base, 6).replace(/,/g, "");

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

  return (
    <fieldset className="policy-form">
      <legend>Spending policy (draft until you activate it)</legend>
      <div className="field">
        <label htmlFor={tierId}>Authority tier</label>
        <select
          id={tierId}
          value={tier}
          onChange={(e) => {
            const v = e.target.value as AgentPolicyInput["tier"];
            setTier(v);
            emit({}, v);
          }}
        >
          <option value="observe">Observe (plan only)</option>
          <option value="bounded_automatic">Bounded automatic</option>
          <option value="approval_required">Approval required</option>
          <option value="stopped">Stopped (reconcile only)</option>
        </select>
      </div>
      <div className="grid-3">
        <Field label="Lifetime allowance (test-USDC)" inputMode="decimal" value={text.lifetime} onChange={(v) => emit({ lifetime: v })} />
        <Field label="Rolling 24 h cap (test-USDC)" inputMode="decimal" value={text.rolling} onChange={(v) => emit({ rolling: v })} />
        <Field label="Per-purchase limit (test-USDC)" inputMode="decimal" value={text.maxPurchase} onChange={(v) => emit({ maxPurchase: v })} />
        <Field label="Per-task budget (test-USDC)" inputMode="decimal" value={text.task} onChange={(v) => emit({ task: v })} />
        <Field label="Usage allowance (microcredits)" inputMode="numeric" value={text.usage} onChange={(v) => emit({ usage: v })} />
        <Field label="Per-task credit cap (microcredits)" inputMode="numeric" value={text.taskCredits} onChange={(v) => emit({ taskCredits: v })} />
      </div>
      <fieldset>
        <legend>Allowed services (SKUs)</legend>
        <div className="checks">
          {allSkus.map((sku) => (
            <label key={sku}>
              <input
                type="checkbox"
                checked={skus.includes(sku)}
                onChange={(e) => {
                  const next = e.target.checked ? [...skus, sku] : skus.filter((s) => s !== sku);
                  setSkus(next);
                  emit({}, tier, next);
                }}
              />{" "}
              {sku}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Allowed payment paths</legend>
        <div className="checks">
          {(["private_x402", "prepaid_credits"] as const).map((p) => (
            <label key={p}>
              <input
                type="checkbox"
                checked={paths.includes(p)}
                onChange={(e) => {
                  const next = e.target.checked ? [...paths, p] : paths.filter((x) => x !== p);
                  setPaths(next);
                  emit({}, tier, skus, next);
                }}
              />{" "}
              {p === "private_x402" ? "Private pool → x402 (test-USDC)" : "Prepaid gateway credits"}
            </label>
          ))}
        </div>
      </fieldset>
    </fieldset>
  );
}

/** Effective policy: the agent's limits shown next to the workspace limits that also apply. */
export function PolicyReview({ policy, workspacePolicy, title, compact }: { policy: Policy | AgentPolicyInput; workspacePolicy: Policy | undefined; title: string; compact?: boolean }) {
  const p = policy as Partial<Policy> & Partial<AgentPolicyInput>;
  const skus = p.permissions?.allowedSkus ?? p.allowedSkus ?? [];
  const paths = p.permissions?.allowedPaymentPaths ?? p.allowedPaymentPaths ?? [];
  const role = (p.roleConfig ?? null) as AgentPolicyInput["roleConfig"] | null;
  if (compact) {
    const ws = (v: string | null | undefined) => (workspacePolicy ? <span className="muted"> · workspace {usdc(v)}</span> : null);
    return (
      <div className="policy-compact">
        <h3>{title}</h3>
        <KV
          rows={[
            ["Per purchase", usdc(p.maxPurchaseTestUsdc)],
            ["Per task", usdc(p.taskLimitTestUsdc)],
            ["Last 24 h", <>{usdc(p.rolling24hTestUsdc)}{ws(workspacePolicy?.rolling24hTestUsdc)}</>],
            ["Lifetime", <>{usdc(p.lifetimeTestUsdc)}{ws(workspacePolicy?.lifetimeTestUsdc)}</>],
            ["Credits", `${credits(p.usageAllowanceUnits)} · ${credits(p.taskCreditUnits)} per task`],
            ["Services", skus.length ? skus.join(", ") : "none"],
            ["Paths", paths.length ? paths.join(", ") : "none"],
            ...(role
              ? [["Top-up rule", `Buy ${credits(role.creditPackUnits)} below ${credits(role.creditLowWatermark)}; check every ${role.pollSeconds} s; ${role.cooldownSeconds} s cooldown`] as [string, string]]
              : []),
          ]}
        />
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Scope</th>
            <th scope="col">This agent</th>
            <th scope="col">Workspace (also enforced)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Tier</th>
            <td>{String(p.tier).replace(/_/g, " ")}</td>
            <td>{workspacePolicy ? workspacePolicy.tier.replace(/_/g, " ") : "not activated"}</td>
          </tr>
          <tr>
            <th scope="row">Lifetime</th>
            <td>{usdc(p.lifetimeTestUsdc)}</td>
            <td>{usdc(workspacePolicy?.lifetimeTestUsdc)}</td>
          </tr>
          <tr>
            <th scope="row">Rolling 24 h</th>
            <td>{usdc(p.rolling24hTestUsdc)}</td>
            <td>{usdc(workspacePolicy?.rolling24hTestUsdc)}</td>
          </tr>
          <tr>
            <th scope="row">Per purchase</th>
            <td>{usdc(p.maxPurchaseTestUsdc)}</td>
            <td>—</td>
          </tr>
          <tr>
            <th scope="row">Per task</th>
            <td>{usdc(p.taskLimitTestUsdc)}</td>
            <td>—</td>
          </tr>
          <tr>
            <th scope="row">Gateway usage</th>
            <td>
              {credits(p.usageAllowanceUnits)} lifetime, {credits(p.taskCreditUnits)} per task
            </td>
            <td>—</td>
          </tr>
          <tr>
            <th scope="row">Services</th>
            <td>{skus.length ? skus.join(", ") : "none"}</td>
            <td>Only approved, bound services</td>
          </tr>
          <tr>
            <th scope="row">Payment paths</th>
            <td>{paths.length ? paths.join(", ") : "none"}</td>
            <td>Devnet test-USDC mint only</td>
          </tr>
          {role ? (
            <tr>
              <th scope="row">Top-up rule</th>
              <td>
                Buy {credits(role.creditPackUnits)} when available credits fall below {credits(role.creditLowWatermark)}; check every {role.pollSeconds} s;{" "}
                {role.cooldownSeconds} s between successful top-ups; one outstanding top-up.
              </td>
              <td>SOL sponsor allowance {workspacePolicy?.sponsorLamportLimit ?? "—"} lamports</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <p className="small muted">These limits are enforced by the owner wallet service off chain; they are not cryptographic caps.</p>
    </div>
  );
}
