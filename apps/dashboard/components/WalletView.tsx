"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api";
import { parseUsdcInput, usdc } from "../lib/format";
import type { NoteStatus, WalletNote } from "../lib/types";
import { connect, listWallets, onWalletsChanged, signAndSend, type OwnerWallet } from "../lib/wallet";
import { useCapability, useOwner, type ConnectedWallet } from "./Shell";
import { useAction, useResource } from "./hooks";
import { ErrorNotice, Loading, Section, Spinner, TxLink } from "./ui";

export const DEPOSIT_STAGES = ["submitted", "finalized", "indexed", "approved", "spendable"] as const;

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

export function NotesTable({ status }: { status: NoteStatus }) {
  if (status.notes.length === 0) return <p className="muted flush">No deposits yet. Add funds below to get started.</p>;
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Deposits</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Amount</th>
            <th scope="col">Ready to spend</th>
            <th scope="col">Progress</th>
          </tr>
        </thead>
        <tbody>
          {status.notes.map((n) => (
            <tr key={n.id}>
              <td>{n.origin === "deposit" ? "Deposit" : "Change"}</td>
              <td>{usdc(n.value.amount)}</td>
              <td>{n.available ? "Yes" : "No"}</td>
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
        <div className="stat">
          <span className="stat-label">Ready to spend</span>
          <span className="stat-value">{t ? usdc(t.spendable.amount) : "—"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Held for purchases</span>
          <span className="stat-value">{t ? usdc(t.reserved.amount) : "—"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">On the way</span>
          <span className="stat-value">{t ? usdc(t.pending.amount) : "—"}</span>
          <span className="stat-sub">Deposits not ready yet</span>
        </div>
      </div>
      <ErrorNotice error={notes.error} what="wallet service" onRetry={notes.reload} />

      <Section title="Add funds">
        <p className="hint flush">Move test-USDC into your private pool. It can be spent once it reaches “Ready”.</p>
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
                    const signature = await signAndSend(connected.wallet, connected.account, prepared.transaction);
                    const r = await api<{ state: string }>("wallet", "/deposits/register", { method: "POST", body: { depositId: prepared.depositId, signature } });
                    setSubmitted({ signature, state: r.state });
                    await notes.reload();
                  })
                }
              >
                Sign in wallet
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
