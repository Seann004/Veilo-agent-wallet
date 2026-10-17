"use client";

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
  return (
    <Section title="Shared treasury">
      <p className="small">
        Cash is USDC paid privately from your pool. AI runs on your own model key; trial planning calls before you add one are paid by the operator.
      </p>
      <div className="grid-2 meters">
        <div className="meter">
          <h3>Cash spent (USDC)</h3>
          <p className="meter-value">{balances.cash ? usdc(balances.cash.spent) : "—"}</p>
          <p className="small muted">{balances.cash ? `${usdc(balances.cash.reserved)} reserved by live purchases` : "Cash accounting unavailable."}</p>
        </div>
        <div className="meter">
          <h3>Trial AI calls</h3>
          <p className="meter-value">{balances.sponsoredPlanning ? `${balances.sponsoredPlanning.total} call(s)` : "—"}</p>
          <p className="small muted">Operator-funded before you add your own key; costs you no USDC.</p>
        </div>
      </div>
      <div className="grid-2">
        <div>
          <h3>Global limits (workspace policy)</h3>
          {wsActive ? (
            <KV
              rows={[
                ["Lifetime", <Usage key="l" u={wsActive.lifetime} label="lifetime" />],
                ["Rolling 24 h", <Usage key="r" u={wsActive.rolling24h} label="in 24 h" />],
                ["SOL sponsor allowance", `${lamports(wsActive.sponsor.available)} remaining of ${lamports(wsActive.sponsor.limit)}`],
                ["Tier", wsActive.tier.replace(/_/g, " ")],
              ]}
            />
          ) : (
            <p className="notice notice-warn">Workspace policy is not activated; no agent can spend.</p>
          )}
        </div>
        <div>
          <h3>Cash (USDC)</h3>
          {balances.cash ? (
            <KV
              rows={[
                ["Cash spent", <strong key="s" data-testid="cash-spent">{usdc(balances.cash.spent)}</strong>],
                ["Cash reserved (live exposure)", usdc(balances.cash.reserved)],
              ]}
            />
          ) : (
            <p className="muted">Cash accounting unavailable.</p>
          )}
          <p className="muted small">{balances.cash?.note}</p>
        </div>
      </div>

      <h3>Per-agent and global remaining</h3>
      <p className="small">
        An agent can spend at most the smallest of its own remaining limits and the workspace&apos;s remaining limits, and never more than its
        per-purchase cap. Pool value is shared by all agents; no agent can spend the whole pool.
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

      <div className="grid-2">
        <div>
          <h3>Pool funds and recoverable funds</h3>
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
        </div>
      </div>
    </Section>
  );
}
