"use client";

import type { ApiError } from "../lib/api";
import { shortKey } from "../lib/format";
import type { Health, Workspace } from "../lib/types";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/**
 * Network line in the page footer. "Live" only when the control service has verified the RPC
 * genesis hash and mint at runtime and they match the workspace's network and mint; any other
 * state is shown as a warning because payments are refused until it clears.
 */
export function NetworkStatus({ health, healthError, workspace }: { health: Health | undefined; healthError: ApiError | undefined; workspace: Workspace["workspace"] | undefined }) {
  let status: string;
  let ok = false;
  let title: string | undefined = workspace ? `Network ${workspace.network}, mint ${workspace.mint}` : undefined;
  if (healthError) status = "Solana devnet · network not confirmed: control service unreachable";
  else if (!health) status = "Solana devnet · checking network…";
  else if (health.chain.state === "verified") {
    const id = health.chain.identity;
    ok = id.genesisHash === DEVNET_GENESIS && (!workspace || (workspace.mint === id.mint && workspace.network === id.caip2));
    status = ok ? "Live on Solana devnet" : "Solana devnet · network or mint mismatch — payments refused";
    title = `Verified devnet · mint ${shortKey(id.mint)}`;
  } else if (health.chain.state === "unavailable") status = "Solana devnet · network not confirmed: devnet RPC unavailable";
  else status = "Solana devnet · network check pending";
  return (
    <footer className="app-foot">
      <span className={ok ? "net-status" : "net-status net-status-warn"} role="status" aria-live="polite" title={title}>
        {status}
      </span>
    </footer>
  );
}
