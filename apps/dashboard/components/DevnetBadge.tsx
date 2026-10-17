"use client";

import type { ApiError } from "../lib/api";
import { shortKey } from "../lib/format";
import type { Health, Workspace } from "../lib/types";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/**
 * Persistent network badge. "Confirmed" only when the control service has verified the RPC
 * genesis hash and mint at runtime and they match the workspace's network and mint.
 */
export function DevnetBadge({ health, healthError, workspace }: { health: Health | undefined; healthError: ApiError | undefined; workspace: Workspace["workspace"] | undefined }) {
  let status: string;
  let ok = false;
  if (healthError) status = "network not confirmed: control service unreachable";
  else if (!health) status = "checking network…";
  else if (health.chain.state === "verified") {
    const id = health.chain.identity;
    const matches = id.genesisHash === DEVNET_GENESIS && (!workspace || (workspace.mint === id.mint && workspace.network === id.caip2));
    ok = matches;
    status = matches ? `confirmed devnet · mint ${shortKey(id.mint)} (${id.mintDecimals} decimals)` : "network or mint mismatch — payments refused";
  } else if (health.chain.state === "unavailable") status = "network not confirmed: devnet RPC unavailable";
  else status = "network check pending";
  return (
    <div className={ok ? "badge badge-ok" : "badge badge-warn"} role="status" aria-live="polite" title={workspace ? `Network ${workspace.network}, mint ${workspace.mint}` : undefined}>
      <strong>Solana devnet</strong>
      <span className="badge-detail">{status}</span>
    </div>
  );
}
