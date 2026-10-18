"use client";

import type { ReactNode } from "react";
import { lamports, minBase, usdc } from "../lib/format";
import { ROLE_LABEL } from "../lib/labels";
import type { Agent, Balances, LimitUsage } from "../lib/types";
import { KV, Section } from "./ui";

const BUCKET_LABEL: Record<string, string> = {
  approved_unreserved: "Approved, unreserved pool notes",
  confirmed_change: "Confirmed private change (spendable)",
  reserved_input: "Notes reserved by live purchases",
  pending_change: "Pending change (unavailable until inserted)",
  payout_balance: "Funded fresh payment wallets (outside the pool)",
  merchant_outflow: "Paid to merchants",
  fee_outflow: "Token fees paid",
  external_recovered: "Recovered to owner account (outside the pool)",
  consumed: "Consumed note value",
};

function Usage({ u, label }: { u: LimitUsage | undefined; label: string }) {
  if (!u) return <span className="muted">not activated</span>;
  return (
    <span>
      <strong>{usdc(u.available)}</strong> remaining of {usdc(u.limit)} {label}
      <span className="muted">
        {" "}
        (settled {usdc(u.settled)}, reserved {usdc(u.reserved)})
      </span>
      {u.overCommitted !== "0" ? <span className="pill pill-danger"> over limit by {usdc(u.overCommitted)}</span> : null}
    </span>
  );
}

/**
 * Shared treasury view. Policy allowances, physical pool value, gateway credits and sponsored
 * planning are separate quantities and are never added together. Credit-pack purchases count
 * once as cash spent; consuming those credits is shown in microcredits, not as a second payment.
 */
export function TreasurySummary({ balances, agents }: { balances: Balances; agents: Agent[] }) {
  const ws = balances.workspace;
  const wsActive = ws.policyVersion !== null ? ws : null;
  // Absent in the public view: pool balance movements could be matched to on-chain withdrawals.
  const buckets = balances.tokens.buckets;
  const poolSpendable = buckets?.approved_unreserved ?? "0";
  const ready = buckets ? (BigInt(buckets.approved_unreserved ?? "0") + BigInt(buckets.confirmed_change ?? "0")).toString() : null;
  const used = (u: LimitUsage) => (BigInt(u.settled) + BigInt(u.reserved)).toString();
  return (
    <Section title="Shared treasury">
      <div className="stats stats-3">
        <div className="stat">
          <span className="stat-label">Ready to spend in pool</span>
          <span className="stat-value">{ready === null ? "—" : usdc(ready)}</span>
          <span className="stat-sub">{ready === null ? "Hidden in the public view" : "Approved notes and change, not reserved"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Spent today</span>
          <span className="stat-value">{wsActive ? usdc(used(wsActive.rolling24h)) : "—"}</span>
          <span className="stat-sub">{wsActive ? `of ${usdc(wsActive.rolling24h.limit)} per 24 h` : "No active workspace policy"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Lifetime used</span>
          <span className="stat-value">{wsActive ? usdc(used(wsActive.lifetime)) : "—"}</span>
          <span className="stat-sub">{wsActive ? `of ${usdc(wsActive.lifetime.limit)} cap` : "No active workspace policy"}</span>
        </div>
      </div>
      {wsActive ? null : <p className="notice notice-warn">Workspace policy is not activated; no agent can spend.</p>}
      <p className="hint">
        Each agent can spend at most its own remaining limit, the workspace&apos;s remaining limit and its per-purchase cap. No agent can spend the whole pool.
      </p>

      <div className="table-wrap">
        <table>
          <caption className="sr-only">Remaining spending limits per agent</caption>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Agent lifetime remaining</th>
              <th scope="col">Agent 24 h remaining</th>
              <th scope="col">Task limit</th>
              <th scope="col">Per purchase</th>
              <th scope="col">Effective remaining now</th>
              <th scope="col">Cash spent / reserved</th>
            </tr>
          </thead>
          <tbody>
            {balances.agents.map((a) => {
              const agent = agents.find((x) => x.id === a.agentId);
              const cash = balances.cash?.byAgent.find((c) => c.agentId === a.agentId);
              const effective = a.lifetime
                ? minBase(a.lifetime.available, a.rolling24h?.available, wsActive?.lifetime.available ?? "0", wsActive?.rolling24h.available ?? "0")
                : "0";
              return (
                <tr key={a.agentId}>
                  <th scope="row">
                    {a.name} <span className="muted small">{ROLE_LABEL[a.role]}</span>
                  </th>
                  <td>{a.lifetime ? `${usdc(a.lifetime.available)} of ${usdc(a.lifetime.limit)}` : "not activated"}</td>
                  <td>{a.rolling24h ? `${usdc(a.rolling24h.available)} of ${usdc(a.rolling24h.limit)}` : "—"}</td>
                  <td>{usdc(agent?.activePolicy?.taskLimitTestUsdc)}</td>
                  <td>{usdc(a.maxPurchase)}</td>
                  <td>
                    <strong>{usdc(effective)}</strong>
                  </td>
                  <td>{cash ? `${usdc(cash.spent)} / ${usdc(cash.reserved)}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="disclosure treasury-details">
        <summary>How limits work</summary>
        <p className="small">
          Cash is USDC paid privately from your pool. AI runs on your own model key; trial planning calls before you add one are paid by the operator
          and cost you no USDC.
        </p>
        <KV
          rows={[
            ["Cash spent", <strong key="s" data-testid="cash-spent">{balances.cash ? usdc(balances.cash.spent) : "—"}</strong>],
            ["Cash reserved (live exposure)", balances.cash ? usdc(balances.cash.reserved) : "—"],
            ["Trial AI calls", balances.sponsoredPlanning ? `${balances.sponsoredPlanning.total} call(s)` : "—"],
            ...(wsActive
              ? ([
                  ["Lifetime", <Usage key="l" u={wsActive.lifetime} label="lifetime" />],
                  ["Rolling 24 h", <Usage key="r" u={wsActive.rolling24h} label="in 24 h" />],
                  ["SOL sponsor allowance", `${lamports(wsActive.sponsor.available)} remaining of ${lamports(wsActive.sponsor.limit)}`],
                  ["Tier", wsActive.tier.replace(/_/g, " ")],
                ] as Array<[string, ReactNode]>)
              : []),
          ]}
        />
        {balances.cash?.note ? <p className="small muted">{balances.cash.note}</p> : null}
        <h3>Pool funds</h3>
        {buckets ? (
          <KV
            rows={[
              ["Spendable pool notes (approved, unreserved)", <strong key="p">{usdc(poolSpendable)}</strong>],
              ...Object.entries(BUCKET_LABEL)
                .filter(([k]) => k !== "approved_unreserved")
                .map(([k, label]) => [label, usdc(buckets[k] ?? "0")] as [string, string]),
            ]}
          />
        ) : (
          <p className="small muted">Pool balances are hidden in the public view.</p>
        )}
        <p className="small muted">
          Funded fresh-wallet balances are recoverable to the owner account once no signed merchant payment can still settle. Recovered funds
          return outside the pool; private spending requires a new deposit.
        </p>
      </details>
    </Section>
  );
}
