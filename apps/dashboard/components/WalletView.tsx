"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api";
import { parseUsdcInput, usdc } from "../lib/format";
import type { NoteStatus, WalletNote } from "../lib/types";
import { connect, listWallets, onWalletsChanged, signAndSend, type OwnerWallet } from "../lib/wallet";
import { useOwner, type ConnectedWallet } from "./Shell";
import { useAction, useResource } from "./hooks";
import { ErrorNotice, Loading, Section, TxLink } from "./ui";

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
  if (w.connected) return <p className="small">Owner wallet connected for signing.</p>;
  return (
    <div className="notice">
      <p>Connect the owner wallet to {purpose}. It signs in the wallet; Veilo never sees your keys.</p>
      {w.wallets.length === 0 ? <p className="muted">No compatible wallet detected.</p> : null}
      {w.wallets.map((x) => (
        <button key={x.name} type="button" className="btn" onClick={() => void w.connectTo(x)}>
          Connect {x.name}
        </button>
      ))}
      <ErrorNotice error={w.error} />
    </div>
  );
}

export function DepositStages({ note }: { note: WalletNote }) {
  const stages = note.depositStages ?? {};
  return (
    <ol className="stages" aria-label="Deposit progress">
      {DEPOSIT_STAGES.map((s) => (
        <li key={s} className={stages[s] ? "stage done" : "stage"}>
          <span aria-hidden="true">{stages[s] ? "●" : "○"}</span> {s}
          <span className="sr-only">{stages[s] ? " reached" : " not reached"}</span>
        </li>
      ))}
    </ol>
  );
}

export function NotesTable({ status }: { status: NoteStatus }) {
  if (status.notes.length === 0) return <p className="muted">No notes yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Pool notes</caption>
        <thead>
          <tr>
            <th scope="col">Origin</th>
            <th scope="col">Value</th>
            <th scope="col">State</th>
            <th scope="col">Counted as available</th>
            <th scope="col">Deposit progress</th>
          </tr>
        </thead>
        <tbody>
          {status.notes.map((n) => (
            <tr key={n.id}>
              <td>{n.origin}</td>
              <td>{usdc(n.value.amount)}</td>
              <td>{n.state.replace(/_/g, " ")}</td>
              <td>{n.available ? "yes" : "no"}</td>
              <td>{n.origin === "deposit" ? <DepositStages note={n} /> : "change note"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WalletView() {
  const notes = useResource(() => api<NoteStatus>("wallet", "/notes/status"), "notes");
  const { connected } = useOwnerWallet();
  const [amount, setAmount] = useState("");
  const [prepared, setPrepared] = useState<{ depositId: string; transaction: string; amount: string; privacyWarning: string } | null>(null);
  const [submitted, setSubmitted] = useState<{ signature: string; state: string } | null>(null);
  const action = useAction();
  const base = parseUsdcInput(amount);

  return (
    <>
      <h1>Wallet</h1>
      <Section title="Pool notes">
        {notes.data ? (
          <>
            <p>
              <strong>Available (spendable notes only): {usdc(notes.data.totals.spendable.amount)}</strong> · reserved {usdc(notes.data.totals.reserved.amount)} · pending (not
              available until approved and spendable) {usdc(notes.data.totals.pending.amount)}
            </p>
            {notes.data.sync && !notes.data.sync.synced ? <p className="notice notice-warn">Chain sync unavailable: {notes.data.sync.reason}</p> : null}
            <NotesTable status={notes.data} />
          </>
        ) : notes.loading ? (
          <Loading label="notes" />
        ) : null}
        <ErrorNotice error={notes.error} what="wallet service" />
        <button type="button" className="btn" onClick={() => void notes.reload()}>
          Refresh from chain
        </button>
      </Section>
      <Section title="Deposit test-USDC into the pool">
        <p className="small">Steps: prepare → sign in your wallet → register. Then the note moves through submitted, finalized, indexed, approved and spendable. Only spendable notes are counted as available.</p>
        <ConnectWalletPrompt purpose="sign the deposit" />
        <form
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
            <label htmlFor="deposit-amount">Amount (test-USDC)</label>
            <input id="deposit-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={amount !== "" && !base} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={!base || action.busy}>
            Prepare deposit
          </button>
        </form>
        {prepared ? (
          <div className="notice">
            <p>
              Deposit of {usdc(prepared.amount)} prepared. <strong>Privacy:</strong> {prepared.privacyWarning}
            </p>
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
              Sign in wallet and register
            </button>
          </div>
        ) : null}
        {submitted ? (
          <p role="status">
            Deposit {submitted.state}: <TxLink signature={submitted.signature} />
          </p>
        ) : null}
        <ErrorNotice error={action.error} />
      </Section>
    </>
  );
}
