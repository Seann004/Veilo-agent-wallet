"use client";

import { api } from "../lib/api";
import { usdc } from "../lib/format";
import type { PublicState } from "../lib/types";
import { useResource } from "./hooks";
import { ErrorNotice, Loading, Section } from "./ui";

/** Below this many distinct approved depositors the pool is flagged as weak. A heuristic, not an anonymity score. */
export const WEAK_POOL_PARTICIPANTS = 5;

export interface Membership {
  approvedLabels: number;
  deposits: number;
  participants: number;
  repeatedAmounts: number;
  weak: boolean;
}

export function membership(ps: PublicState): Membership {
  const approved = new Set(ps.approved.labels);
  const approvedDeposits = ps.deposits.filter((d) => approved.has(d.label));
  const participants = new Set(approvedDeposits.map((d) => d.refundAuthority)).size;
  const counts = new Map<string, number>();
  for (const d of ps.deposits) counts.set(d.amount, (counts.get(d.amount) ?? 0) + 1);
  const repeatedAmounts = [...counts.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);
  return { approvedLabels: approved.size, deposits: ps.deposits.length, participants, repeatedAmounts, weak: participants < WEAK_POOL_PARTICIPANTS };
}

export function PrivacyPanel() {
  const ps = useResource(() => api<PublicState>("relayer", "/public-state"), "public-state");
  const m = ps.data ? membership(ps.data) : null;
  const verified = ps.data ? ps.data.consistent && ps.data.approved.consistent : false;
  return (
    <>
      <p className="lede page-lede">Agents pay from a shared private pool. Here&apos;s what that hides, and what it doesn&apos;t.</p>
      <div className="grid-2 privacy-cards">
        <section className="panel">
          <h2 className="panel-title">Hidden</h2>
          <ul className="check-list">
            <li>Which of your deposits paid for a purchase</li>
          </ul>
        </section>
        <section className="panel">
          <h2 className="panel-title">Public on Solana devnet</h2>
          <ul className="check-list muted-list">
            <li>Deposit amounts, sender and time</li>
            <li>Payments: merchant, amount, fees and time</li>
            <li>Withdrawals and recoveries, including your address</li>
          </ul>
        </section>
      </div>
      <details className="panel disclosure">
        <summary>Who else can see what</summary>
        <ul>
          <li>The gateway sees the credit account, prompts and usage.</li>
          <li>OpenRouter sees the operator account and prompts, not your workspace.</li>
          <li>The RPC provider can link requests together.</li>
        </ul>
        <p className="small muted">
          No anonymity is promised. Timing, unusual amounts and a small pool can link payments to you. A withdrawal can reveal roughly how much you spent. Spending limits are enforced by
          your wallet service, not on-chain.
        </p>
      </details>
      <Section title="How private is the pool right now?">
        {ps.loading && !ps.data ? <Loading label="pool size" /> : null}
        <ErrorNotice error={ps.error} what="public pool state from the relayer" onRetry={ps.reload} />
        {ps.data && m ? (
          <>
            {!verified ? (
              <p className="notice notice-warn" role="alert">
                Can&apos;t verify the pool right now, so these numbers may be incomplete. The operator needs to publish the approved-deposit list (APPROVED_LABELS_PATH).
              </p>
            ) : null}
            {m.weak && verified ? (
              <p className="notice notice-warn" role="alert">
                Weak privacy: only {m.participants} different depositor(s). A purchase can likely be traced back to you.
              </p>
            ) : null}
            {m.repeatedAmounts === 0 && m.deposits > 0 ? <p className="notice notice-warn">Every deposit amount is different, which makes them easier to match.</p> : null}
            <div className="stats">
              <div className="stat">
                <span className="stat-label">Depositors</span>
                <span className="stat-value">{m.participants}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Deposits</span>
                <span className="stat-value">{m.deposits}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Payments / withdrawals</span>
                <span className="stat-value">
                  {ps.data.spends.length} / {ps.data.exits.length}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">In the pool</span>
                <span className="stat-value">{usdc(ps.data.pool.liability)}</span>
              </div>
            </div>
            <p className="small muted flush">Demo depositors are test accounts, not real people. Approved deposits: {m.approvedLabels}.</p>
          </>
        ) : null}
      </Section>
    </>
  );
}
