"use client";

import { credits, lamports, minBase, usdc } from "../lib/format";
import { GATEWAY_CREDIT_LABEL, LABEL_CREDITS_NO_CHARGE, ROLE_LABEL, SPONSORED_PLANNING_LABEL } from "../lib/labels";
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
  const buckets = balances.tokens.buckets;
  const poolSpendable = buckets.approved_unreserved ?? "0";
  const gc = balances.gatewayCredits;
  return (
    <Section title="Shared treasury">
      <p className="small">
        Three separate meters. They are never added together: cash is devnet test-USDC with no real value, credits are a prepaid balance bought with that cash, and sponsored planning is paid by the operator.
      </p>
      <div className="grid-3 meters">
        <div className="meter">
          <h3>Cash spent (test-USDC)</h3>
          <p className="meter-value">{balances.cash ? usdc(balances.cash.spent) : "—"}</p>
          <p className="small muted">{balances.cash ? `${usdc(balances.cash.reserved)} reserved by live purchases` : "Cash accounting unavailable."}</p>
        </div>
        <div className="meter">
          <h3>Prepaid credits</h3>
          <p className="meter-value">{gc.available ? credits(gc.usable) : "Not ready"}</p>
          <p className="small muted">
            {gc.available ? `${credits(gc.consumed)} consumed so far. Using credits is not a second payment.` : "The gateway balance could not be read; no balance is shown."}
          </p>
        </div>
        <div className="meter">
          <h3>Sponsored planning</h3>
          <p className="meter-value">{balances.sponsoredPlanning ? `${balances.sponsoredPlanning.total} call(s)` : "—"}</p>
          <p className="small muted">Operator-funded; costs you no cash or credits.</p>
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
          <h3>Cash (test-USDC)</h3>
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
          <h3>{GATEWAY_CREDIT_LABEL}</h3>
          {gc.available ? (
            <>
              <KV
                rows={[
                  ["Credits purchased", credits(gc.purchased)],
                  ["Credits consumed", credits(gc.consumed)],
                  ["Credits reserved", credits(gc.reserved)],
                  ["Credits available", <strong key="u">{credits(gc.usable)}</strong>],
                ]}
              />
              {gc.stale ? <p className="notice notice-warn">Balance is stale; Shawn pauses top-up checks until it refreshes.</p> : null}
              <p className="small">
                Credit packs are bought with test-USDC and counted once in cash spent. Calls that use prepaid credits: “{LABEL_CREDITS_NO_CHARGE}”.
              </p>
            </>
          ) : (
            <p className="notice notice-warn" role="status">
              Not ready: {gc.message} ({gc.code})
            </p>
          )}
          {balances.usageByAgent ? (
            <ul className="plain small">
              {balances.usageByAgent.map((u) => (
                <li key={u.agentId}>
                  {u.name}: consumed {credits(u.consumedUnits)}, reserved {credits(u.reservedUnits)}
                  {u.packsPurchased > 0 ? `; bought ${u.packsPurchased} pack(s) = ${credits(u.packUnitsPurchased)} for ${usdc(u.packCashSpent)} (already in cash spent)` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {balances.sponsoredPlanning ? (
            <p className="small">
              <strong>{SPONSORED_PLANNING_LABEL}</strong>: {balances.sponsoredPlanning.total} call(s), operator-funded and separate from cash and
              credits.
            </p>
          ) : null}
        </div>
        <div>
          <h3>Pool funds and recoverable funds</h3>
          <KV
            rows={[
              ["Spendable pool notes (approved, unreserved)", <strong key="p">{usdc(poolSpendable)}</strong>],
              ...Object.entries(BUCKET_LABEL)
                .filter(([k]) => k !== "approved_unreserved")
                .map(([k, label]) => [label, usdc(buckets[k] ?? "0")] as [string, string]),
            ]}
          />
          <p className="small muted">
            Funded fresh-wallet balances are recoverable to the owner account once no signed merchant payment can still settle. Recovered funds
            return outside the pool; private spending requires a new deposit.
          </p>
        </div>
      </div>
    </Section>
  );
}
