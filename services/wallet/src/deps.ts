import type { Address } from "@solana/kit";
import { bytesToHex, toBe32, type Poseidon } from "@veilo/privacy-sdk";
import type { PaymentSigningRequest } from "@veilo/x402-client";
import type { FundingBinding } from "@veilo/contracts";
import type { PoolContext } from "./pool";
import type { ChainPort, ControlPort, ProverPort, RelayerPort } from "./ports";
import type { WalletStore } from "./store";
import type { SwapQuoter } from "./swap";

/**
 * Produces the single signed x402 payment for a validated challenge. The production
 * implementation runs @veilo/x402-client `preparePayment` with the constrained signer.
 */
export interface MerchantSigner {
  sign(input: {
    paymentRequired: unknown;
    binding: FundingBinding;
    exactAmount: bigint;
    purchaseRef: string;
    wallet: { address: Address; signPaymentMessage(r: PaymentSigningRequest): Promise<Uint8Array> };
  }): Promise<{ paymentSignatureHeader: string; messageHash: string; recentBlockhash: string | null }>;
}

export interface WalletDeps {
  store: WalletStore;
  poseidon: Poseidon;
  control: ControlPort;
  relayer: RelayerPort;
  chain: ChainPort;
  prover: ProverPort;
  merchant: MerchantSigner;
  /** Verified deployment context (manifest checked against local configuration). */
  pool: () => Promise<PoolContext>;
  /** Preconfigured owner recovery account; recovery and swap output never go anywhere else. */
  ownerRecoveryAddress: Address | null;
  /** Devnet swap quoter; swaps are unavailable without it. */
  swapQuoter?: SwapQuoter;
  /** Slots of margin required before an intent's bound when handing a proof to the relayer. */
  releaseMarginSlots?: bigint;
  now?: () => number;
  /** Diagnostic lines; never given key material, note secrets or transaction bytes. */
  log?: (line: string) => void;
}

export const hex64 = (x: bigint): string => bytesToHex(toBe32(x));
export const hexToField = (h: string): bigint => BigInt(`0x${h}`);

/** Serializes work per key inside this process (database constraints guard across processes). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
