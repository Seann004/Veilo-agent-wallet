import { createDevnetRpc } from "@veilo/contracts";
import { signature as toSignature, type Address, type Base64EncodedWireTransaction, type Signature } from "@solana/kit";

export interface TxRecord {
  signature: string;
  slot: bigint;
  err: unknown;
}

/** Chain access for the relayer and indexer. Reads are at finalized commitment unless noted. */
export interface RelayerChain {
  finalizedSlot(): Promise<bigint>;
  finalizedBlockHeight(): Promise<bigint>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  account(addr: Address): Promise<{ data: Uint8Array; lamports: bigint; owner: string; executable: boolean } | null>;
  /** All finalized signatures touching `addr`, oldest first. */
  signaturesForAddress(addr: Address): Promise<TxRecord[]>;
  transaction(signature: string): Promise<{ slot: bigint; err: unknown; logs: string[]; fee: bigint; tokenTransfers?: Array<{ mint: string; destination: string; amount: bigint }> } | null>;
  signatureStatus(signature: string): Promise<{ confirmationStatus: "processed" | "confirmed" | "finalized"; err: unknown } | null>;
  rentExemptMinimum(bytes: number): Promise<bigint>;
  /** Sends a fully signed wire transaction; the caller persisted its signature first. */
  send(wireBase64: string): Promise<void>;
}

export function createRpcRelayerChain(rpcUrl: string): RelayerChain {
  const rpc = createDevnetRpc(rpcUrl);
  return {
    finalizedSlot: () => rpc.getSlot({ commitment: "finalized" }).send(),
    finalizedBlockHeight: () => rpc.getBlockHeight({ commitment: "finalized" }).send(),
    async latestBlockhash() {
      const { value } = await rpc.getLatestBlockhash({ commitment: "finalized" }).send();
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    },
    async account(addr) {
      const { value } = await rpc.getAccountInfo(addr, { encoding: "base64", commitment: "finalized" }).send();
      if (!value) return null;
      return { data: new Uint8Array(Buffer.from(value.data[0], "base64")), lamports: value.lamports, owner: value.owner, executable: value.executable };
    },
    async signaturesForAddress(addr) {
      const out: TxRecord[] = [];
      let before: Signature | undefined;
      for (;;) {
        const page = await rpc.getSignaturesForAddress(addr, { limit: 1000, commitment: "finalized", ...(before ? { before } : {}) }).send();
        for (const s of page) out.push({ signature: s.signature, slot: s.slot, err: s.err });
        if (page.length < 1000) break;
        before = page[page.length - 1]!.signature;
      }
      return out.reverse();
    },
    async transaction(sig) {
      const tx = await rpc.getTransaction(toSignature(sig), { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }).send();
      if (!tx) return null;
      return { slot: tx.slot, err: tx.meta?.err ?? null, logs: [...(tx.meta?.logMessages ?? [])], fee: tx.meta?.fee ?? 0n, tokenTransfers: parsedTokenTransfers(tx) };
    },
    async signatureStatus(sig) {
      const { value } = await rpc.getSignatureStatuses([toSignature(sig)], { searchTransactionHistory: true }).send();
      const s = value[0];
      if (!s || s.confirmationStatus === null) return null;
      return { confirmationStatus: s.confirmationStatus, err: s.err };
    },
    rentExemptMinimum: (bytes) => rpc.getMinimumBalanceForRentExemption(BigInt(bytes)).send(),
    async send(wire) {
      await rpc.sendTransaction(wire as Base64EncodedWireTransaction, { encoding: "base64", preflightCommitment: "confirmed" }).send();
    },
  };
}

/** Exact SPL amounts from executed inner instructions, never a quote or account-rent delta. */
export function parsedTokenTransfers(tx: unknown): Array<{ mint: string; destination: string; amount: bigint }> {
  const raw = tx as { meta?: { innerInstructions?: Array<{ instructions: Array<{ program?: string; parsed?: { type?: string; info?: { mint?: string; destination?: string; tokenAmount?: { amount?: string } } } }> }> } };
  return (raw.meta?.innerInstructions ?? []).flatMap((group) => group.instructions.flatMap((ix) => {
    const info = ix.parsed?.info;
    return ix.program === "spl-token" && ix.parsed?.type === "transferChecked" && info?.mint && info.destination && /^\d+$/.test(info.tokenAmount?.amount ?? "")
      ? [{ mint: info.mint, destination: info.destination, amount: BigInt(info.tokenAmount!.amount!) }] : [];
  }));
}
