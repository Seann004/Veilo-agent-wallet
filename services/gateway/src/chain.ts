import { createDevnetRpc } from "@veilo/contracts";
import { address, signature as toSignature } from "@solana/kit";
import { decodeWireTransaction, messageHashOf } from "@veilo/x402-client";

export interface ObservedTransaction {
  slot: bigint;
  /** Null when the transaction executed without error. */
  err: unknown;
  messageHash: string;
  commitment: "confirmed" | "finalized";
}

/** Read-only chain access used for challenges and settlement reconciliation. */
export interface GatewayChain {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  getFinalizedBlockHeight(): Promise<bigint>;
  /** Returns the transaction at the requested commitment, or null if not (yet) visible. */
  getTransaction(signature: string, commitment: "confirmed" | "finalized"): Promise<ObservedTransaction | null>;
  /** Recent signatures touching an address (newest first). */
  getSignaturesForAddress(addr: string, limit: number): Promise<string[]>;
}

export function createRpcChain(rpcUrl: string): GatewayChain {
  const rpc = createDevnetRpc(rpcUrl);
  return {
    async getLatestBlockhash() {
      const { value } = await rpc.getLatestBlockhash({ commitment: "finalized" }).send();
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
    },
    async getFinalizedBlockHeight() {
      return rpc.getBlockHeight({ commitment: "finalized" }).send();
    },
    async getTransaction(sig, commitment) {
      const tx = await rpc
        .getTransaction(toSignature(sig), { commitment, encoding: "base64", maxSupportedTransactionVersion: 0 })
        .send();
      if (!tx) return null;
      const [wire] = tx.transaction;
      const decoded = decodeWireTransaction(wire);
      return {
        slot: tx.slot,
        err: tx.meta?.err ?? null,
        messageHash: messageHashOf(new Uint8Array(decoded.messageBytes)),
        commitment,
      };
    },
    async getSignaturesForAddress(addr, limit) {
      const rows = await rpc.getSignaturesForAddress(address(addr), { limit, commitment: "confirmed" }).send();
      return rows.map((r) => r.signature);
    },
  };
}
