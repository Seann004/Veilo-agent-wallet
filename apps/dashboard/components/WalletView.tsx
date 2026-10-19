"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api";
import { parseUsdcInput, usdc, when } from "../lib/format";
import { percent } from "../lib/spend";
import type { NoteStatus, PublicState, WalletNote } from "../lib/types";
import { connect, lastWallet, listWallets, onWalletsChanged, rememberWallet, signAndSend, type OwnerWallet } from "../lib/wallet";
import { StackedBar, Stat } from "./Charts";
import { membership } from "./PrivacyPanel";
import { useCapability, useOwner, type ConnectedWallet } from "./Shell";
import { useAction, useResource } from "./hooks";
import { SwapPanel } from "./SwapPanel";
import { Amount } from "./UsdcIcon";
import { ErrorNotice, Loading, Section, Spinner, TxLink } from "./ui";

export const DEPOSIT_STAGES = ["submitted", "finalized", "indexed", "approved", "spendable"] as const;

// One silent reconnect per page load, however many components ask for the wallet.
let silentTried = false;

/** Ensures the owner's wallet is connected for transaction signing; any other account is refused. */
export function useOwnerWallet(): { connected: ConnectedWallet | null; wallets: OwnerWallet[]; connectTo: (w: OwnerWallet) => Promise<void>; error: ApiError | undefined } {
  const { connected, setConnected, workspace } = useOwner();
  const [wallets, setWallets] = useState<OwnerWallet[]>([]);
  const [error, setError] = useState<ApiError>();
  useEffect(() => {
    const refresh = () => setWallets(listWallets());
    refresh();
    return onWalletsChanged(refresh);
  }, []);
  // Reconnects the wallet used last time without a prompt; a wallet that would prompt is left alone.
  useEffect(() => {
    if (connected || silentTried) return;
    const name = lastWallet();
    const w = name ? wallets.find((x) => x.name === name) : undefined;
    if (!w) return;
    silentTried = true;
    connect(w.wallet, true)
      .then((account) => {
        if (account.address === workspace.workspace.ownerPubkey) setConnected({ wallet: w.wallet, account });
      })
      .catch(() => undefined);
  }, [connected, wallets, workspace.workspace.ownerPubkey, setConnected]);
  return {
    connected,
    wallets,
    error,
    connectTo: async (w) => {
      try {
        const account = await connect(w.wallet);
        if (account.address !== workspace.workspace.ownerPubkey) {
          setError(new ApiError(403, "FORBIDDEN", "the connected account is not the workspace owner"));
          return;
        }
        setError(undefined);
        rememberWallet(w.name);
        setConnected({ wallet: w.wallet, account });
      } catch (e) {
        setError(new ApiError(0, "WALLET", (e as Error).message));
      }
    },
  };
}

export function ConnectWalletPrompt({ purpose }: { purpose: string }) {
  const w = useOwnerWallet();
  if (w.connected) return <p className="small muted">Wallet connected.</p>;
  return (
    <div className="notice">
      <p className="flush">Connect your wallet to {purpose}. Veilo never sees your keys.</p>
      {w.wallets.length === 0 ? <p className="small muted">No wallet found. Install or unlock Phantom, then reload.</p> : null}
      <div className="actions">
        {w.wallets.map((x) => (
          <button key={x.name} type="button" className="btn btn-small" onClick={() => void w.connectTo(x)}>
            Connect {x.name}
          </button>
        ))}
      </div>
      <ErrorNotice error={w.error} />
    </div>
  );
}

const STAGE_LABEL: Record<(typeof DEPOSIT_STAGES)[number], string> = {
  submitted: "Sent",
  finalized: "Confirmed",
  indexed: "Recorded",
  approved: "Approved",
  spendable: "Ready",
};

export function DepositStages({ note }: { note: WalletNote }) {
  const stages = note.depositStages ?? {};
  // A prepared deposit the wallet never sent (for example, the approval was dismissed) moved no funds.
  if (!DEPOSIT_STAGES.some((s) => stages[s])) return <span className="muted">Not sent; no funds moved</span>;
  return (
    <ol className="stages" aria-label="Deposit progress">
      {DEPOSIT_STAGES.map((s) => (
        <li key={s} className={stages[s] ? "stage done" : "stage"}>
          <span aria-hidden="true">{stages[s] ? "●" : "○"}</span> {STAGE_LABEL[s]}
          <span className="sr-only">{stages[s] ? " reached" : " not reached"}</span>
        </li>
      ))}
    </ol>
  );
}

/** Newest first; notes from a wallet service without timestamps keep their order at the end. */
function newestFirst(notes: WalletNote[]): WalletNote[] {
  return [...notes].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export function NotesTable({ status }: { status: NoteStatus }) {
  if (status.notes.length === 0) return <p className="muted flush">No deposits yet. Add funds below to get started.</p>;
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Deposits</caption>
        <thead>
          <tr>
            <th scope="col">Added</th>
            <th scope="col">Source</th>
            <th scope="col" className="num">Amount</th>
            <th scope="col">Ready to spend</th>
            <th scope="col">Progress</th>
          </tr>
        </thead>
        <tbody>
          {newestFirst(status.notes).map((n) => (
            <tr key={n.id}>
              <td title={n.updatedAt ? `Last change ${when(n.updatedAt)}` : undefined}>{n.createdAt ? when(n.createdAt) : "—"}</td>
              <td>{n.origin === "deposit" ? "Deposit" : "Change"}</td>
              <td className="num">{usdc(n.value.amount)}</td>
              <td>
                <span className={`pill ${n.available ? "pill-ok" : "pill-muted"}`}>{n.available ? "Yes" : "No"}</span>
              </td>
              <td>{n.origin === "deposit" ? <DepositStages note={n} /> : n.state.replace(/_/g, " ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Note balances, deposits and exits are the owner's private wallet; other roles never request them. */
export function OwnerOnlyNotice({ what, reason }: { what: string; reason: string | null }) {
  return (
    <div className="notice" role="status">
      <p className="flush">
        <strong>{what} is owner-only.</strong> {reason}
      </p>
      <p className="hint flush">Private pool activity is still visible on the Activity page and in the Privacy tab.</p>
    </div>
  );
}

export function WalletView() {
  const fund = useCapability("fund");
  if (!fund.allowed) return <OwnerOnlyNotice what="The private wallet" reason={fund.reason} />;
  return <OwnerWalletView />;
}

function OwnerWalletView() {
  const notes = useResource(() => api<NoteStatus>("wallet", "/notes/status"), "notes");
  const { connected } = useOwnerWallet();
  const [amount, setAmount] = useState("");
  const [prepared, setPrepared] = useState<{ depositId: string; transaction: string; amount: string; privacyWarning: string } | null>(null);
  const [submitted, setSubmitted] = useState<{ signature: string; state: string } | null>(null);
  const action = useAction();
  const base = parseUsdcInput(amount);
  const t = notes.data?.totals;

  return (
    <>
      <div className="stats stats-3">
        <Stat label="Ready to spend" value={t ? usdc(t.spendable.amount) : "—"} sub="Yours, in the private pool" />
        <Stat label="Held for purchases" value={t ? usdc(t.reserved.amount) : "—"} sub="Reserved by live payments" />
        <Stat label="On the way" value={t ? usdc(t.pending.amount) : "—"} sub={t && t.pending.amount !== "0" ? "Deposits not ready yet" : "Nothing pending"} />
      </div>
      <ErrorNotice error={notes.error} what="wallet service" onRetry={notes.reload} />
      <PoolTotal notes={notes.data} />

      <Section title="Add funds">
        <p className="hint flush">Deposit USDC into your private pool.</p>
        <ConnectWalletPrompt purpose="sign the deposit" />
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!base) return;
            void action.run(async () => {
              setSubmitted(null);
              setPrepared(await api("wallet", "/deposits/prepare", { method: "POST", body: { amount: base } }));
            });
          }}
        >
          <div className="field">
            <label htmlFor="deposit-amount">Amount</label>
            <span className="input-unit">
              <input id="deposit-amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={amount !== "" && !base} />
              <span aria-hidden="true">USDC</span>
            </span>
          </div>
          <button type="submit" className="btn btn-primary" disabled={!base || action.busy}>
            {action.busy && !prepared ? <Spinner /> : null}
            Continue
          </button>
        </form>
        {prepared ? (
          <div className="notice">
            <p className="flush">
              Ready to deposit {usdc(prepared.amount)}. <strong>Privacy:</strong> {prepared.privacyWarning}
            </p>
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!connected || action.busy || submitted !== null}
                onClick={() =>
                  void action.run(async () => {
                    if (!connected) return;
                    let signature: string;
                    try {
                      signature = await signAndSend(connected.wallet, connected.account, prepared.transaction);
                    } catch (e) {
                      // Nothing was sent; the next attempt prepares a fresh transaction instead of reusing an expired one.
                      setPrepared(null);
                      throw e;
                    }
                    const r = await api<{ state: string }>("wallet", "/deposits/register", { method: "POST", body: { depositId: prepared.depositId, signature } });
                    setSubmitted({ signature, state: r.state });
                    await notes.reload();
                  })
                }
              >
                Deposit with Phantom
              </button>
            </div>
          </div>
        ) : null}
        {submitted ? (
          <p role="status">
            Deposit {submitted.state}: <TxLink signature={submitted.signature} />
          </p>
        ) : null}
        <ErrorNotice error={action.error} />
      </Section>

      <SwapPanel />
      <Section
        title="Deposits"
        actions={
          <button type="button" className="btn btn-small" onClick={() => void notes.reload()}>
            Refresh
          </button>
        }
      >
        {notes.data ? (
          <>
            {notes.data.sync && !notes.data.sync.synced ? <p className="notice notice-warn">Couldn&apos;t sync with the chain: {notes.data.sync.reason}</p> : null}
            <NotesTable status={notes.data} />
          </>
        ) : notes.loading ? (
          <Loading label="deposits" />
        ) : (
          <p className="muted flush">Deposits can&apos;t be shown until the wallet service is available.</p>
        )}
      </Section>
    </>
  );
}

/**
 * The whole pool as read from the chain by the relayer: every depositor's funds, not just the
 * owner's. Its size is what a payment hides among, so a small pool is flagged.
 */
export function PoolTotal({ notes }: { notes: NoteStatus | undefined }) {
  const ps = useResource(() => api<PublicState>("relayer", "/public-state"), "public-state");
  const m = ps.data ? membership(ps.data) : null;
  const total = ps.data?.pool.liability;
  const t = notes?.totals;
  const mine = t ? BigInt(t.spendable.amount) + BigInt(t.reserved.amount) : null;
  // The relayer and wallet service read at different moments; a split that does not add up is not drawn.
  const verified = ps.data?.consistent === true && ps.data.approved.consistent;
  const split = verified && total !== undefined && mine !== null && t && mine <= BigInt(total) ? { rest: (BigInt(total) - mine).toString(), ready: t.spendable.amount, held: t.reserved.amount } : null;
  return (
    <section className="panel pool-card" aria-labelledby="pool-title">
      <div className="viz-head">
        <h2 id="pool-title">Pool total (all depositors)</h2>
        <Link className="viz-link" href="/privacy">
          How private is it?
        </Link>
      </div>
      {ps.loading && !ps.data ? <Loading label="pool total" /> : null}
      <ErrorNotice error={ps.error} what="public pool state from the relayer" onRetry={ps.reload} />
      {ps.data && m && total !== undefined ? (
        <>
          <div className="pool-figures">
            <div>
              <span className="pool-value">
                <Amount value={usdc(total)} />
              </span>
              <span className="stat-sub">All depositors · public on Solana devnet</span>
            </div>
            <dl className="pool-facts">
              <div>
                <dt>Approved depositor addresses</dt>
                <dd>{m.participants}</dd>
              </div>
              <div>
                <dt>Deposits</dt>
                <dd>{m.deposits}</dd>
              </div>
              {split ? (
                <div>
                  <dt>Your ready + held share</dt>
                  <dd>{Math.round(percent(BigInt(split.ready) + BigInt(split.held), total))}%</dd>
                </div>
              ) : null}
            </dl>
          </div>
          {split ? (
            <StackedBar
              label="Pool total"
              segments={[
                { key: "ready", label: "Yours, ready to spend", value: split.ready, slot: 1 },
                { key: "held", label: "Yours, held for purchases", value: split.held, slot: 2 },
                { key: "rest", label: "Rest of the pool", value: split.rest, slot: 0, hint: "Other depositors and deposits not ready yet" },
              ]}
            />
          ) : null}
          <p className="hint flush">Addresses can belong to the same person. Demo depositors are test accounts; this count is not an anonymity score.</p>
          {!verified ? <p className="notice notice-warn flush" role="status">Pool membership could not be verified. These figures may be incomplete; privacy cannot be assessed.</p> : null}
          {m.weak && ps.data.consistent && ps.data.approved.consistent ? (
            <p className="notice notice-warn flush" role="status">
              Small pool: {m.participants} approved depositor address{m.participants === 1 ? "" : "es"}. A small pool means weak privacy; payments may be easier to trace.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
