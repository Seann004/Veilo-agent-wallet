import type { Actor } from "./actor";

/** Detail keys an anonymous viewer may see on an activity event; everything else is dropped. */
const VIEWER_DETAIL_KEYS = [
  "role",
  "sku",
  "paymentPath",
  "kind",
  "revision",
  "reviewState",
  "from",
  "to",
  "version",
  "tier",
  "toAgentId",
  "artifactId",
  "taskId",
  "reason",
] as const;

/** Purchase fields that carry operation identifiers, chain evidence or execution internals. */
const VIEWER_PURCHASE_OMIT = ["chainAttempts", "operationId", "requestDigest", "stateReason", "execution"] as const;

export const isViewer = (actor: Actor): boolean => actor.kind === "viewer";

type Json = Record<string, unknown>;

/** Session events and worker-credential events are omitted entirely; details are reduced to the allowlist. */
export function redactActivityEvents(events: readonly Json[]): Json[] {
  return events
    .filter((e) => e.scope !== "session" && !(typeof e.action === "string" && e.action.startsWith("worker_credential.")))
    .map((e) => {
      const details = e.details !== null && typeof e.details === "object" ? (e.details as Json) : {};
      const kept: Json = {};
      for (const k of VIEWER_DETAIL_KEYS) if (k in details) kept[k] = details[k];
      return { ...e, details: kept };
    });
}

export function redactPurchase(view: Json): Json {
  const out: Json = { ...view };
  for (const k of VIEWER_PURCHASE_OMIT) delete out[k];
  return out;
}

/**
 * Private-pool token buckets are withheld: polling them reveals when and by how much the pool
 * balance moved, which can be matched against on-chain withdrawals.
 */
export function redactBalances(balances: Json): Json {
  const out: Json = { ...balances };
  const tokens = balances.tokens;
  if (tokens !== null && typeof tokens === "object") {
    const rest: Json = { ...(tokens as Json) };
    delete rest.buckets;
    out.tokens = rest;
  }
  const credits = balances.gatewayCredits;
  if (credits !== null && typeof credits === "object") {
    const rest: Json = { ...(credits as Json) };
    delete rest.accountId;
    out.gatewayCredits = rest;
  }
  return out;
}
