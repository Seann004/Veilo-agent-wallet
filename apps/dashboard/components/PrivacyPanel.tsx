"use client";

import { api } from "../lib/api";
import { usdc } from "../lib/format";
import type { PublicState } from "../lib/types";
import { useResource } from "./hooks";
import { ErrorNotice, KV, Loading, Section } from "./ui";

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
  return (
    <>
      <h1>Privacy</h1>
      <Section title="What is public and what is hidden">
        <div className="grid-2">
          <div>
            <h3>Public on Solana devnet</h3>
            <ul>
              <li>Deposits: amount, source account and timing</li>
              <li>Payouts to fresh payment wallets: amount, mint, fresh wallet and timing</li>
              <li>Merchant payments: merchant, amount, fees</li>
              <li>Public exits and recoveries, including your refund or recovery address</li>
            </ul>
          </div>
          <div>
            <h3>Hidden</h3>
            <ul>
              <li>Which deposit note funded a given withdrawal (the explicit note link)</li>
            </ul>
            <h3>Visible to service operators</h3>
            <ul>
              <li>The gateway sees the credit account, prompts, usage and connection metadata</li>
              <li>OpenRouter sees the operator account and forwarded prompts; workspace IDs are not forwarded</li>
              <li>The RPC provider can correlate requests</li>
            </ul>
          </div>
        </div>
        <p className="small">
          No anonymity is claimed. Timing, distinctive amounts and small pools can link payments. A public exit may reveal aggregate spending by subtraction. Spending caps are enforced off
          chain by the owner wallet service.
        </p>
      </Section>
      <Section title="Pool membership">
        {ps.loading && !ps.data ? <Loading label="public pool state" /> : null}
        <ErrorNotice error={ps.error} what="public pool state from the relayer" />
        {ps.data && m ? (
          <>
            {m.weak ? (
              <p className="notice notice-warn" role="alert">
                Weak pool: only {m.participants} distinct approved depositor(s). Effective privacy is weak; a withdrawal can likely be attributed to you.
              </p>
            ) : null}
            {m.repeatedAmounts === 0 && m.deposits > 0 ? <p className="notice notice-warn">Every deposit amount is distinct, which makes amounts easier to match.</p> : null}
            <KV
              rows={[
                ["Approved labels (approved-set size)", String(m.approvedLabels)],
                ["Distinct approved depositors", String(m.participants)],
                ["Deposits observed", String(m.deposits)],
                ["Withdrawals / exits observed", `${ps.data.spends.length} / ${ps.data.exits.length}`],
                ["Pool liability", usdc(ps.data.pool.liability)],
                ["Indexer consistent", ps.data.consistent && ps.data.approved.consistent ? "yes" : "no — public state mismatch"],
              ]}
            />
            <p className="small">Membership size is not a measure of independent active users. Demo participants are synthetic test participants.</p>
            <p className="small muted">{ps.data.approved.rule}</p>
          </>
        ) : null}
      </Section>
    </>
  );
}
