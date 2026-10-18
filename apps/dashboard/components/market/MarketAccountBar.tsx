"use client";

import { useEffect, useState } from "react";
import { SIGN_IN_STATEMENT, SPENDING_BOUNDARY } from "../../lib/market/messages";
import { listWallets, onWalletsChanged, type OwnerWallet } from "../../lib/wallet";
import { useAction } from "../hooks";
import { ErrorNotice } from "../ui";
import { useMarket } from "./MarketContext";
import { shortKey } from "../../lib/format";
import { Address } from "./parts";

/** Marketplace sign-in status, the wallet-switch pause and the sign-in/sign-out controls. */
export function MarketAccountBar() {
  const m = useMarket();
  const [wallets, setWallets] = useState<OwnerWallet[]>([]);
  const action = useAction();
  useEffect(() => {
    const refresh = () => setWallets(listWallets());
    refresh();
    return onWalletsChanged(refresh);
  }, []);

  if (!m.configured) {
    return (
      <section className="panel market-account" aria-label="Marketplace account">
        <p className="notice notice-warn" role="status">
          <strong>Not ready</strong>: the marketplace is not configured for this dashboard. Set NEXT_PUBLIC_SUPABASE_URL,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and NEXT_PUBLIC_MARKETPLACE_URL, then restart the dashboard.
        </p>
      </section>
    );
  }

  const walletButtons = (verb: string) =>
    wallets.length === 0 ? (
      <p className="small muted">No compatible wallet detected. Install or unlock Phantom (or another Wallet Standard wallet) with Solana devnet support.</p>
    ) : (
      <div className="actions">
        {wallets.map((w) => (
          <button key={w.name} type="button" className="btn btn-small btn-primary" disabled={action.busy} onClick={() => void action.run(() => m.signIn(w))}>
            <img src={w.icon} alt="" width={20} height={20} /> {verb} {w.name}
          </button>
        ))}
      </div>
    );

  return (
    <section className="market-account" aria-label="Marketplace account">
      {!m.ready ? (
        <p role="status" className="muted">
          Checking marketplace sign-in…
        </p>
      ) : m.me ? (
        <div className="account-row">
          <p className="account-who small" role="status">
            Signed in to the marketplace as{" "}
            <span className="mono" title={m.me.address} aria-label={m.me.address}>
              {shortKey(m.me.address, 6)}
            </span>
            {m.wallet ? null : <span className="muted"> · no wallet needed to browse</span>}
          </p>
          <div className="actions">
            <button type="button" className="btn btn-small" disabled={action.busy} onClick={() => void action.run(() => m.signOut())}>
              Sign out of marketplace
            </button>
            {m.wallet ? (
              <button type="button" className="btn btn-small" disabled={action.busy} onClick={() => void action.run(() => m.disconnectWallet())}>
                Disconnect wallet
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="account-row">
          <p className="small muted account-who" title={`${SIGN_IN_STATEMENT} ${SPENDING_BOUNDARY}`}>
            Hiring and selling use a separate marketplace sign-in. It's a login message only, nothing is spent.
          </p>
          {walletButtons("Sign in with")}
        </div>
      )}
      {m.mismatch && m.me ? (
        <div className="notice notice-warn" role="alert">
          <strong>Wallet switched.</strong> Your wallet is now on <Address value={m.mismatch} />, but this marketplace session belongs to{" "}
          <Address value={m.me.address} />. Hiring, approvals and seller actions are paused. Switch the wallet back, or sign in again for the new
          address. The session never moves to it automatically.
          {walletButtons("Sign in again with")}
        </div>
      ) : null}
      {m.meError ? <ErrorNotice error={m.meError} what="marketplace account" onRetry={m.reloadMe} /> : null}
      <ErrorNotice error={action.error} what="marketplace sign-in" />
    </section>
  );
}
