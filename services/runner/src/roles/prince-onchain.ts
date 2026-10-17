/** What the owner asked Prince to look up on chain. Addresses are data; they are validated, never interpreted. */
export interface OnchainTarget {
  mint?: string;
  wallet?: string;
}

export interface ExternalCatalogTerms {
  bindingId: string;
  label: string;
  resourcePath: string;
  unitPrice: string;
  maxCalls: number;
  rpcMethods: string[] | null;
}

export interface PlannedCall {
  method: "POST";
  path: string;
  body: { jsonrpc: "2.0"; id: number; method: string; params: unknown[] };
}

/** One purchased RPC response, citable by method, params, slot and settlement signature. */
export interface OnchainRecord {
  n: number;
  method: string;
  params: unknown[];
  slot: number | null;
  signature: string | null;
  result: unknown;
  error: string | null;
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function validTarget(t: unknown): OnchainTarget | null {
  if (typeof t !== "object" || t === null) return null;
  const x = t as Record<string, unknown>;
  const out: OnchainTarget = {};
  if (typeof x.mint === "string" && BASE58_ADDRESS.test(x.mint)) out.mint = x.mint;
  if (typeof x.wallet === "string" && BASE58_ADDRESS.test(x.wallet)) out.wallet = x.wallet;
  return out.mint || out.wallet ? out : null;
}

/** Read-only calls for the target, limited to the binding's allowed methods and call count. */
export function planCalls(target: OnchainTarget, terms: ExternalCatalogTerms): PlannedCall[] {
  const wanted: Array<[string, unknown[]]> = [];
  if (target.mint) {
    wanted.push(["getTokenSupply", [target.mint]]);
    wanted.push(["getTokenLargestAccounts", [target.mint]]);
    wanted.push(["getAccountInfo", [target.mint, { encoding: "jsonParsed" }]]);
  }
  if (target.wallet) {
    wanted.push(["getBalance", [target.wallet]]);
    wanted.push(["getSignaturesForAddress", [target.wallet, { limit: 5 }]]);
  }
  const path = terms.resourcePath.endsWith("/*") ? null : terms.resourcePath;
  if (path === null) return [];
  return wanted
    .filter(([m]) => terms.rpcMethods === null || terms.rpcMethods.includes(m))
    .slice(0, terms.maxCalls)
    .map(([method, params], i) => ({ method: "POST", path, body: { jsonrpc: "2.0", id: i + 1, method, params } }));
}

/** Pairs each planned call with its purchased response and settlement signature. */
export function toRecords(
  calls: PlannedCall[],
  result: { calls?: Array<{ index: number; payment: string; settlementSignature: string | null; response?: unknown }> } | null,
): OnchainRecord[] {
  const paid = result?.calls ?? [];
  return calls.flatMap((c, i) => {
    const r = paid.find((p) => p.index === i);
    if (!r || r.payment !== "paid") return [];
    const body = (r.response as { json?: { result?: unknown; error?: { message?: unknown } } } | null)?.json;
    const res = body?.result as { context?: { slot?: unknown } } | undefined;
    const slot = typeof res?.context?.slot === "number" ? res.context.slot : null;
    const error = typeof body?.error?.message === "string" ? body.error.message.slice(0, 300) : body === undefined ? "response was not JSON" : null;
    return [{ n: i + 1, method: c.body.method, params: c.body.params, slot, signature: r.settlementSignature, result: body?.result ?? null, error }];
  });
}

/** Deterministic findings read from the purchased responses; nothing here comes from a model. */
export function findings(records: OnchainRecord[]): Array<{ text: string; cite: number }> {
  const out: Array<{ text: string; cite: number }> = [];
  for (const r of records) {
    if (r.error) {
      out.push({ text: `${r.method} returned an error: ${r.error}`, cite: r.n });
      continue;
    }
    const v = (r.result as { value?: unknown } | null)?.value;
    if (r.method === "getTokenSupply") {
      const s = v as { uiAmountString?: unknown; decimals?: unknown } | undefined;
      if (typeof s?.uiAmountString === "string") out.push({ text: `Total supply is ${s.uiAmountString} tokens (${String(s.decimals)} decimals).`, cite: r.n });
    } else if (r.method === "getTokenLargestAccounts" && Array.isArray(v)) {
      const top = v[0] as { address?: unknown; uiAmountString?: unknown } | undefined;
      out.push({ text: `The ${v.length} largest token accounts were returned${top && typeof top.uiAmountString === "string" ? `; the largest holds ${top.uiAmountString} tokens (${String(top.address)})` : ""}.`, cite: r.n });
    } else if (r.method === "getAccountInfo") {
      const info = (v as { data?: { parsed?: { info?: { mintAuthority?: unknown; freezeAuthority?: unknown } } } } | null)?.data?.parsed?.info;
      if (info) out.push({ text: `Mint authority: ${info.mintAuthority === null ? "none (fixed supply)" : String(info.mintAuthority)}; freeze authority: ${info.freezeAuthority === null ? "none" : String(info.freezeAuthority)}.`, cite: r.n });
    } else if (r.method === "getBalance" && typeof v === "number") {
      out.push({ text: `Wallet balance is ${v / 1e9} SOL (${v} lamports).`, cite: r.n });
    } else if (r.method === "getSignaturesForAddress" && Array.isArray(r.result)) {
      out.push({ text: `${r.result.length} recent transaction signature(s) were returned for the wallet.`, cite: r.n });
    }
  }
  return out;
}

export function evidenceText(records: OnchainRecord[]): string {
  return records
    .map((r) => `[${r.n}] ${r.method}(${JSON.stringify(r.params)}) at slot ${r.slot ?? "unknown"}: ${r.error ? `error ${r.error}` : JSON.stringify(r.result).slice(0, 3_000)}`)
    .join("\n")
    .slice(0, 20_000);
}
