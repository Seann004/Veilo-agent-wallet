// Post-run acceptance checks for demo:run. A run counts as complete only when every check passes;
// otherwise the evidence is still written, but labeled as failing, and the command exits non-zero.

export interface AcceptancePurchase {
  id: string;
  agentId: string;
  sku: string;
  paymentPath: string;
  price: { amount: string };
  states: Record<string, string>;
  chainAttempts?: Array<{ leg: string; signature: string | null }>;
}

export interface AcceptanceReceipt {
  sourceKind: string;
  sku: string | null;
  mode: string;
  state: string;
}

export interface AcceptanceInput {
  providerMode: "live" | "fixture";
  agents: { shawn: string; prince: string; mira: string };
  tasks: { prince?: { state?: unknown } | undefined; mira?: { state?: unknown } | undefined };
  purchases: AcceptancePurchase[];
  receipts: AcceptanceReceipt[];
  /**
   * Base units each merchant-leg signature moved into the gateway merchant ATA, read from the
   * finalized transaction. null: the transaction was not found or did not credit that ATA.
   */
  merchantCredits: Record<string, bigint | null>;
}

export interface AcceptanceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AcceptanceResult {
  passed: boolean;
  checks: AcceptanceCheck[];
}

/** Base units credited to `ataAddress` by a jsonParsed or json transaction (post minus pre). */
export function tokenCreditTo(
  tx: {
    transaction: { message: { accountKeys: ReadonlyArray<string | { pubkey: string }> } };
    meta: {
      err: unknown;
      preTokenBalances?: ReadonlyArray<{ accountIndex: number | bigint; uiTokenAmount: { amount: string } }> | null;
      postTokenBalances?: ReadonlyArray<{ accountIndex: number | bigint; uiTokenAmount: { amount: string } }> | null;
    } | null;
  } | null,
  ataAddress: string,
): bigint | null {
  if (!tx?.meta || tx.meta.err !== null) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const index = keys.indexOf(ataAddress);
  if (index < 0) return null;
  const amountAt = (list: typeof tx.meta.preTokenBalances) => {
    const entry = (list ?? []).find((b) => Number(b.accountIndex) === index);
    return entry ? BigInt(entry.uiTokenAmount.amount) : 0n;
  };
  const delta = amountAt(tx.meta.postTokenBalances) - amountAt(tx.meta.preTokenBalances);
  return delta > 0n ? delta : null;
}

export function merchantSignatures(p: AcceptancePurchase): string[] {
  return (p.chainAttempts ?? []).filter((a) => a.leg === "merchant" && a.signature).map((a) => a.signature!);
}

export function evaluateDemoAcceptance(i: AcceptanceInput): AcceptanceResult {
  const checks: AcceptanceCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const taskState = (t: { state?: unknown } | undefined) => (t && typeof t.state === "string" ? t.state : "missing");
  add("Prince research task completed", taskState(i.tasks.prince) === "completed", `state ${taskState(i.tasks.prince)}`);
  add("Mira content task completed", taskState(i.tasks.mira) === "completed", `state ${taskState(i.tasks.mira)}`);

  const privatePurchase = (label: string, agentId: string, match: (sku: string) => boolean) => {
    const found = i.purchases.filter((p) => p.agentId === agentId && match(p.sku) && p.paymentPath === "private_x402");
    const delivered = found.filter((p) => p.states.fulfilment === "delivered");
    if (delivered.length !== 1) {
      add(`${label} delivered once via private x402`, false, `${delivered.length} delivered of ${found.length} matching purchases`);
      return;
    }
    const p = delivered[0]!;
    const funding = (p.chainAttempts ?? []).some((a) => a.leg === "funding" && a.signature);
    add(`${label} delivered once via private x402`, funding, funding ? `purchase ${p.id}` : `purchase ${p.id} has no funding (pool withdrawal) signature`);
    const price = BigInt(p.price.amount);
    const credited = merchantSignatures(p).map((s) => i.merchantCredits[s] ?? null);
    const paid = credited.some((c) => c !== null && c >= price);
    add(
      `${label} merchant leg paid the gateway merchant`,
      paid,
      paid ? `${price} base units to the gateway merchant ATA` : `no finalized merchant-leg transaction credits the gateway merchant ATA with ${price} base units`,
    );
  };
  privatePurchase("Shawn credit pack", i.agents.shawn, (s) => s === "inference-credit-pack");
  privatePurchase("Prince research dataset", i.agents.prince, (s) => s.startsWith("research-"));
  privatePurchase("Mira content package", i.agents.mira, (s) => s === "content-package");

  const succeeded = (sku: string) => i.receipts.filter((r) => r.sku === sku && r.state === "succeeded");
  for (const sku of ["analyze", "content-package"]) {
    const ok = succeeded(sku).filter((r) => r.mode === i.providerMode);
    add(`${sku} inference succeeded (${i.providerMode})`, ok.length >= 1, `${ok.length} succeeded ${i.providerMode} provider call(s)`);
  }
  if (i.providerMode === "live") {
    const fixture = i.receipts.filter((r) => r.mode !== "live");
    add("no fixture provider call in a live run", fixture.length === 0, `${fixture.length} non-live provider call(s)`);
  }
  return { passed: checks.every((c) => c.ok), checks };
}
