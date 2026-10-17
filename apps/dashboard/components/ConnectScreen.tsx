"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { connect, listWallets, onWalletsChanged, signChallenge, type OwnerWallet } from "../lib/wallet";
import type { ConnectedWallet } from "./Shell";
import { useAction } from "./hooks";
import { ErrorNotice } from "./ui";

/** The control service answers POLICY_DENIED when the wallet is neither the owner nor an approved guest. */
export const NOT_ALLOWED_WALLET = "This wallet is not the workspace owner or an approved guest. Switch to an allowed wallet in your wallet app and try again.";

/** Sign-in for the owner or an approved guest: connect a Wallet Standard wallet and sign a one-time challenge. */
export function ConnectScreen({ onSignedIn, onCancel }: { onSignedIn: (c: ConnectedWallet) => Promise<void>; onCancel?: (() => void) | undefined }) {
  const [wallets, setWallets] = useState<OwnerWallet[]>([]);
  const action = useAction();
  useEffect(() => {
    const refresh = () => setWallets(listWallets());
    refresh();
    return onWalletsChanged(refresh);
  }, []);

  const signIn = (w: OwnerWallet) =>
    action.run(async () => {
      const account = await connect(w.wallet);
      const ch = await api<{ nonce: string; message: string }>("control", "/session/challenge", { method: "POST", body: { address: account.address } });
      const signature = await signChallenge(w.wallet, account, ch.message);
      await api("control", "/session/verify", { method: "POST", body: { address: account.address, nonce: ch.nonce, signature, message: ch.message } });
      await onSignedIn({ wallet: w.wallet, account });
    });

  const notAllowed = action.error?.status === 403 && action.error.code === "POLICY_DENIED";
  return (
    <div className="panel connect">
      <h1>Sign in</h1>
      <p>
        Connect the workspace owner wallet or an approved guest wallet and sign a one-time sign-in message. The message authorizes no
        transaction. Veilo never asks for your seed phrase or private key.
      </p>
      <p className="hint">Guests can view everything and run agents. Funding, policy, approvals and stop controls stay with the owner.</p>
      {wallets.length === 0 ? (
        <p className="notice notice-warn" role="status">
          No compatible wallet detected. Install or unlock Phantom (or another Wallet Standard wallet) with Solana devnet support, then reload.
        </p>
      ) : (
        <ul className="wallet-list">
          {wallets.map((w) => (
            <li key={w.name}>
              <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void signIn(w)}>
                <img src={w.icon} alt="" width={20} height={20} /> Sign in with {w.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {action.busy ? (
        <p role="status" className="muted">
          Waiting for the wallet…
        </p>
      ) : null}
      {notAllowed ? (
        <p className="notice notice-error" role="alert">
          {NOT_ALLOWED_WALLET}
        </p>
      ) : (
        <ErrorNotice error={action.error} what="sign-in failed" />
      )}
      {onCancel ? (
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Back to the read-only view
        </button>
      ) : null}
    </div>
  );
}
