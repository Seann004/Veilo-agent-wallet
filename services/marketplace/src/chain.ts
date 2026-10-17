import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Address } from "@solana/kit";
import { MarketError } from "./errors";

export interface ExpectedTransfer {
  signature: string;
  mint: string;
  recipient: string;
  recipientAta: string;
  amount: bigint;
  /** When set, the transfer must be authorized by this wallet (the payer bound to the operation). */
  sourceOwner?: string | undefined;
}

export interface VerifiedTransfer {
  signature: string;
  instructionIndex: number;
  mint: string;
  sourceOwner: string | null;
  recipientAta: string;
  amount: bigint;
  slot: bigint;
  /** Block time in seconds, as reported by the cluster; null when unavailable. */
  blockTime: number | null;
}

export type ReceiptOutcome = { status: "verified"; transfer: VerifiedTransfer } | { status: "pending" } | { status: "invalid"; reason: string };

interface ParsedIx {
  program?: string;
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}

// The JSON-RPC jsonParsed transaction shape; only the fields read below are typed.
export interface ParsedTransaction {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    innerInstructions?: Array<{ index: number; instructions: ParsedIx[] }>;
    postTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string }>;
  } | null;
  transaction: { message: { accountKeys: Array<{ pubkey: string } | string>; instructions: ParsedIx[] } };
}

function key(k: { pubkey: string } | string): string {
  return typeof k === "string" ? k : k.pubkey;
}

/**
 * Checks one finalized transaction for exactly one SPL Token transfer of the expected mint and
 * amount into the expected token account owned by the expected recipient. Pure, so it is unit
 * tested against recorded transaction shapes.
 */
export function checkTransfer(tx: ParsedTransaction | null, expected: ExpectedTransfer): ReceiptOutcome {
  if (!tx) return { status: "pending" };
  if (!tx.meta) return { status: "invalid", reason: "transaction has no status metadata" };
  if (tx.meta.err !== null && tx.meta.err !== undefined) return { status: "invalid", reason: "transaction failed on chain" };
  const keys = tx.transaction.message.accountKeys.map(key);
  const flat: Array<{ index: number; ix: ParsedIx }> = tx.transaction.message.instructions.map((ix, i) => ({ index: i, ix }));
  for (const inner of tx.meta.innerInstructions ?? []) {
    inner.instructions.forEach((ix, j) => flat.push({ index: 1000 * (inner.index + 1) + j, ix }));
  }
  const transfers = flat.filter(({ ix }) => {
    const program = ix.programId ?? "";
    const type = ix.parsed?.type;
    return (ix.program === "spl-token" || program === TOKEN_PROGRAM_ADDRESS) && (type === "transfer" || type === "transferChecked");
  });
  const toRecipient = transfers.filter(({ ix }) => ix.parsed?.info?.destination === expected.recipientAta);
  if (toRecipient.length !== 1) return { status: "invalid", reason: `expected one transfer to the seller token account, found ${toRecipient.length}` };
  const { index, ix } = toRecipient[0]!;
  const info = ix.parsed?.info ?? {};
  const destIndex = keys.indexOf(expected.recipientAta);
  const destBalance = tx.meta.postTokenBalances?.find((b) => b.accountIndex === destIndex);
  const mint = typeof info.mint === "string" ? info.mint : destBalance?.mint;
  if (mint !== expected.mint) return { status: "invalid", reason: "transfer mint differs from the quote" };
  if (destBalance?.owner !== expected.recipient) return { status: "invalid", reason: "destination token account is not owned by the quoted recipient" };
  const rawAmount = (info.tokenAmount as { amount?: string } | undefined)?.amount ?? info.amount;
  if (typeof rawAmount !== "string" || !/^\d+$/.test(rawAmount)) return { status: "invalid", reason: "transfer amount unreadable" };
  if (BigInt(rawAmount) !== expected.amount) return { status: "invalid", reason: "transfer amount differs from the quoted total" };
  const authority = info.authority ?? info.multisigAuthority;
  if (expected.sourceOwner !== undefined && authority !== expected.sourceOwner) {
    return { status: "invalid", reason: "transfer was not authorized by the expected payer" };
  }
  return {
    status: "verified",
    transfer: {
      signature: expected.signature,
      instructionIndex: index,
      mint,
      sourceOwner: typeof authority === "string" ? authority : null,
      recipientAta: expected.recipientAta,
      amount: BigInt(rawAmount),
      slot: BigInt(tx.slot),
      blockTime: tx.blockTime ?? null,
    },
  };
}

export async function deriveAta(owner: string, mint: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ owner: owner as Address, mint: mint as Address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return ata;
}

export interface Chain {
  genesisHash(): Promise<string>;
  /** Finalized parsed transaction, or null while it is not yet finalized or unknown. */
  finalizedTransaction(signature: string): Promise<ParsedTransaction | null>;
  tokenAccount(address: string): Promise<{ mint: string; owner: string } | null>;
}

export function createRpcChain(rpcUrl: string, fetchImpl: typeof fetch = fetch): Chain {
  let id = 0;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new MarketError("PROVIDER_UNAVAILABLE", "chain RPC unreachable");
      }
      // A 429 is an unprocessed rejection, so a bounded retry of a read is safe.
      if (res.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new MarketError("PROVIDER_UNAVAILABLE", `chain RPC HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { message?: string } };
      if (body.error) throw new MarketError("PROVIDER_UNAVAILABLE", "chain RPC error");
      return body.result as T;
    }
  }
  return {
    genesisHash: () => call<string>("getGenesisHash", []),
    finalizedTransaction: (signature) =>
      call<ParsedTransaction | null>("getTransaction", [signature, { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]),
    async tokenAccount(address) {
      const r = await call<{ value: { data?: { parsed?: { info?: { mint?: string; owner?: string } } } } | null }>("getAccountInfo", [
        address,
        { commitment: "finalized", encoding: "jsonParsed" },
      ]);
      const info = r.value?.data?.parsed?.info;
      return info?.mint && info.owner ? { mint: info.mint, owner: info.owner } : null;
    },
  };
}
