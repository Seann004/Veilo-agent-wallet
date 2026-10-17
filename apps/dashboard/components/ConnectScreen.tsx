"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { connect, listWallets, onWalletsChanged, signChallenge, type OwnerWallet } from "../lib/wallet";
import type { ConnectedWallet } from "./Shell";
import { useAction } from "./hooks";
import { ErrorNotice } from "./ui";

/** Owner sign-in: connect a Wallet Standard wallet and sign a one-time challenge message. */
export function ConnectScreen({ onSignedIn }: { onSignedIn: (c: ConnectedWallet) => Promise<void> }) {
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

  return (
    <div className="panel connect">
      <h1>Owner sign-in</h1>
      <p>
        Connect the workspace owner wallet and sign a one-time sign-in message. The message authorizes no transaction. Veilo never asks for
        your seed phrase or private key.
      </p>
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
      <ErrorNotice error={action.error} what="sign-in failed" />
    </div>
  );
}
