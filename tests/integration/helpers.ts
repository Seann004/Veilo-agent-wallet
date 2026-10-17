// Shared helpers for the integration suite: one local stack (validator, facilitator, FIXTURE
// provider, five service processes behind fault proxies) used by every scenario in order.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeRequestDigest } from "@veilo/contracts/gateway";
import { openSqliteReadonly } from "../../packages/db/src/index";
import { sleep } from "../../scripts/devnet/lib";
import { WorkerClient, type Reply } from "../../scripts/local-stack/owner-client";
import { createLocalStack, type LocalStack } from "../../scripts/local-stack/stack";

export const BASE_PORT = Number(process.env.VEILO_IT_BASE_PORT ?? "5600");
export const STACK_NAME = "integration";
/** Suffix that keeps idempotency keys unique per run when a stack is reused. */
export const RUN_ID = Date.now().toString(36);
export const runKey = (key: string): string => `${key}:${RUN_ID}`;

export interface Ctx {
  s: LocalStack;
  agents: Record<"Shawn" | "Prince" | "Mira", string>;
  workers: Record<"Shawn" | "Prince" | "Mira", WorkerClient>;
  services: Array<{ id: string; service_key: string; skus: Array<{ sku: string; paymentPath: string }> }>;
  /** Evidence collected per acceptance test ID for the run summary. */
  evidence: Record<string, unknown>;
}

export const TERMINAL = new Set(["delivered", "paid_without_result", "abandoned"]);

export async function bootCtx(): Promise<Ctx> {
  const reuse = process.env.VEILO_IT_REUSE === "1" && existsSync(join("work", STACK_NAME, "stack.env"));
  const s = await createLocalStack({ name: STACK_NAME, basePort: BASE_PORT, reuse, extraEnv: { CONTROL_PURCHASE_SWEEP_MS: "5000", WALLET_NOTE_SYNC_MS: "4000" } });
  const ws = await s.owner.workspace();
  const id = (n: string) => (ws.agents as Array<{ id: string; name: string }>).find((a) => a.name === n)!.id;
  const agents = { Shawn: id("Shawn"), Prince: id("Prince"), Mira: id("Mira") };
  const workers = {
    Shawn: new WorkerClient(s.controlUrl, await s.owner.workerToken(agents.Shawn)),
    Prince: new WorkerClient(s.controlUrl, await s.owner.workerToken(agents.Prince)),
    Mira: new WorkerClient(s.controlUrl, await s.owner.workerToken(agents.Mira)),
  };
  return { s, agents, workers, services: ws.services, evidence: {} };
}

/** Generous caps so ordinary scenarios are never limited by policy; cap tests set their own. */
export async function openPolicies(c: Ctx): Promise<void> {
  await c.s.owner.activateSeededPolicies();
  await c.s.owner.setWorkspacePolicy({ tier: "bounded_automatic", lifetimeTestUsdc: "500000000", rolling24hTestUsdc: "500000000", sponsorLamportLimit: "5000000000" });
  for (const name of ["Prince", "Mira"] as const) {
    await c.s.owner.setAgentPolicy(c.agents[name], {
      tier: "bounded_automatic",
      lifetimeTestUsdc: "100000000",
      rolling24hTestUsdc: "100000000",
      maxPurchaseTestUsdc: "1000000",
      taskLimitTestUsdc: "5000000",
      usageAllowanceUnits: "50000000",
      taskCreditUnits: "5000000",
      allowedSkus: name === "Prince" ? ["research-basic", "research-expanded", "summarize", "analyze", "inference-credit-pack"] : ["content-package", "summarize", "analyze"],
      allowedPaymentPaths: ["private_x402", "prepaid_credits"],
    });
  }
}

export function serviceId(c: Ctx, sku: string, path: string): string {
  const s = c.services.find((x) => x.skus.some((k) => k.sku === sku && k.paymentPath === path));
  if (!s) throw new Error(`no service for ${sku}/${path}`);
  return s.id;
}

export async function intent(c: Ctx, agent: keyof Ctx["workers"], key: string, sku: string, path: "private_x402" | "prepaid_credits", input: Record<string, unknown>): Promise<Reply> {
  return c.workers[agent].call("POST", "/purchase-intents", {
    idempotencyKey: runKey(key),
    serviceId: serviceId(c, sku, path),
    sku,
    paymentPath: path,
    requestDigest: computeRequestDigest(sku, input),
    input,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function purchase(c: Ctx, id: string): Promise<any> {
  const r = await c.s.owner.control("GET", `/purchases/${id}`);
  return r.body;
}

/** Waits for control (whose sweep keeps reconciling) to reach a terminal or recoverable state. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function waitPurchase(c: Ctx, id: string, pred: (p: any) => boolean = (p) => TERMINAL.has(p.purchase.states.fulfilment) || p.purchase.states.recovery !== "none", timeoutMs = 300_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await purchase(c, id).catch(() => null);
    if (p?.purchase && pred(p)) return p;
    if (Date.now() > deadline) throw new Error(`purchase ${id} did not reach the expected state: ${JSON.stringify(p?.purchase?.states ?? p)} ${JSON.stringify(p?.execution?.blocked ?? null)}`);
    await sleep(3_000);
  }
}

export function q<T = Record<string, unknown>>(c: Ctx, db: "control" | "gateway" | "relayer" | "wallet", sql: string, ...args: unknown[]): T[] {
  const path = db === "wallet" ? join(c.s.dir, "secrets", "wallet-secrets.sqlite") : join(c.s.dir, "data", `${db}.sqlite`);
  const d = openSqliteReadonly(path);
  try {
    return d.prepare(sql).all(...args) as T[];
  } finally {
    d.close();
  }
}

export const n = (c: Ctx, db: "control" | "gateway" | "relayer" | "wallet", sql: string, ...args: unknown[]): number => Number(Object.values(q(c, db, sql, ...args)[0] ?? { x: 0 })[0]);

/**
 * Per-purchase duplication invariants across all ledgers: at most one withdrawal per proof
 * nullifier, at most one settled merchant payment, one gateway purchase per operation and one
 * settled expense in control.
 */
export function invariants(c: Ctx, purchaseId: string): Record<string, number> {
  const p = q<{ operation_id: string }>(c, "control", "SELECT operation_id FROM purchase WHERE id = ?", purchaseId)[0]!;
  const nullifiers = q<{ nullifier_hash: string }>(c, "wallet", "SELECT nullifier_hash FROM funding WHERE purchase_id = ?", purchaseId).map((r) => r.nullifier_hash);
  const r = {
    walletFundings: nullifiers.length,
    relayerWithdrawals: nullifiers.length === 0 ? 0 : n(c, "relayer", `SELECT count(*) FROM withdrawal WHERE nullifier_hash IN (${nullifiers.map(() => "?").join(",")})`, ...nullifiers),
    relayerSpendFinalized: nullifiers.length === 0 ? 0 : n(c, "relayer", `SELECT count(*) FROM withdrawal WHERE state = 'finalized' AND nullifier_hash IN (${nullifiers.map(() => "?").join(",")})`, ...nullifiers),
    merchantPayments: n(c, "wallet", "SELECT count(*) FROM merchant_payment WHERE purchase_id = ?", purchaseId),
    gatewayPurchases: n(c, "gateway", "SELECT count(*) FROM purchases WHERE operation_id = ?", p.operation_id),
    gatewayPaymentEvents: n(c, "gateway", "SELECT count(*) FROM payment_events e JOIN purchases g ON g.id = e.purchase_id WHERE g.operation_id = ?", p.operation_id),
    controlExpenseSettled: n(c, "control", "SELECT count(*) FROM financial_event WHERE purchase_id = ? AND kind = 'expense_settled'", purchaseId),
  };
  return r;
}

export async function hold(): Promise<{ wait: Promise<void>; release: () => void }> {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
}
