import { isAddress } from "@solana/kit";
import { z } from "zod";

/**
 * Relayer/indexer wire contract. Requests are strict objects: an unknown field (for example a
 * note secret) is rejected, so the relayer never accepts more than public proof material.
 */

const address = z.string().refine((v) => isAddress(v), "must be a base58 Solana address");
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,76})$/, "must be a canonical decimal");
const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/, "must be a u64 decimal string");
const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(4096);

export const groth16ProofWire = z
  .object({
    pi_a: z.array(decimal).length(3),
    pi_b: z.array(z.array(decimal).length(2)).length(3),
    pi_c: z.array(decimal).length(3),
    protocol: z.literal("groth16"),
    curve: z.literal("bn128"),
  })
  .strict();

export const withdrawalIntentWire = z
  .object({
    destinationTokenAccount: address,
    destinationOwner: address,
    payoutAmount: u64,
    relayerFee: u64,
    relayer: address.nullable(),
    relayerFeeTokenAccount: address.nullable(),
    validUntilSlot: u64,
  })
  .strict();
export type WithdrawalIntentWire = z.infer<typeof withdrawalIntentWire>;

export const withdrawalRequestWire = z
  .object({
    withdrawalId: z.uuid(),
    proof: groth16ProofWire,
    /** Spend public signals in circuit order: context, stateRoot, approvedRoot, nullifierHash, withdrawnValue, newCommitment. */
    publicSignals: z.array(decimal).length(6),
    intent: withdrawalIntentWire,
    /** Upper bound on sponsor lamports (ATA rent + fees) for this withdrawal. */
    sponsorLamportCap: u64,
  })
  .strict();
export type WithdrawalRequestWire = z.infer<typeof withdrawalRequestWire>;

export const WITHDRAWAL_STATES = ["accepted", "ata_submitted", "submitted", "finalized", "failed", "expired", "rejected"] as const;
export type WithdrawalState = (typeof WITHDRAWAL_STATES)[number];

export const withdrawalViewWire = z
  .object({
    withdrawalId: z.uuid(),
    state: z.enum(WITHDRAWAL_STATES),
    nullifierHash: decimal,
    validUntilSlot: u64,
    ataSignature: z.string().nullable(),
    signature: z.string().nullable(),
    blockhash: z.string().nullable(),
    lastValidBlockHeight: u64.nullable(),
    sponsorFeeLamports: u64,
    sponsorRentLamports: u64,
    finalizedSlot: u64.nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type WithdrawalViewWire = z.infer<typeof withdrawalViewWire>;

export const recoveryRequestWire = z
  .object({
    recoveryId: z.uuid(),
    /** Wire transaction (base64) carrying the fresh wallet's signature; the sponsor signs as fee payer. */
    transaction: base64,
    /** Last valid block height of the transaction blockhash (persisted before submission). */
    lastValidBlockHeight: u64,
    freshWallet: address,
    destinationAta: address,
    amount: u64,
  })
  .strict();
export type RecoveryRequestWire = z.infer<typeof recoveryRequestWire>;

export const recoveryViewWire = z
  .object({
    recoveryId: z.uuid(),
    state: z.enum(["submitted", "finalized", "failed", "expired"]),
    signature: z.string(),
    blockhash: z.string(),
    lastValidBlockHeight: u64,
    sponsorFeeLamports: u64,
    rentRecoveredLamports: u64,
    error: z.string().nullable(),
  })
  .strict();
export type RecoveryViewWire = z.infer<typeof recoveryViewWire>;

export const swapRequestWire = z
  .object({
    swapId: z.uuid(),
    /** Wire transaction (base64) carrying the fresh wallet's signature; the sponsor signs as fee payer. */
    transaction: base64,
    lastValidBlockHeight: u64,
    freshWallet: address,
    /** Receives the unwrapped SOL. */
    destination: address,
  })
  .strict();
export type SwapRequestWire = z.infer<typeof swapRequestWire>;

export const swapViewWire = z
  .object({
    swapId: z.uuid(),
    state: z.enum(["submitted", "finalized", "failed", "expired"]),
    signature: z.string(),
    lastValidBlockHeight: u64,
    sponsorFeeLamports: u64,
    /** Wrapped-SOL account rent the sponsor funded; it leaves with the output and is not recovered. */
    sponsorRentLamports: u64,
    rentRecoveredLamports: u64,
    actualOutLamports: u64.optional(),
    error: z.string().nullable(),
  })
  .strict();
export type SwapViewWire = z.infer<typeof swapViewWire>;

export const publicLeafWire = z.object({ index: z.number().int().min(0), commitment: decimal, kind: z.enum(["deposit", "change"]), queueSeq: u64 }).strict();

export const publicStateWire = z
  .object({
    finalizedSlot: u64,
    consistent: z.boolean(),
    mismatches: z.array(z.string()),
    pool: z
      .object({
        poolState: address,
        currentRoot: decimal,
        knownRoots: z.array(decimal),
        nextLeafIndex: u64,
        queueHead: u64,
        queueTail: u64,
        liability: u64,
        minDeposit: u64,
        maxDeposit: u64,
        maxRelayerFee: u64,
        depositsPaused: z.boolean(),
      })
      .strict(),
    leaves: z.array(publicLeafWire),
    deposits: z.array(
      z
        .object({
          queueSeq: u64,
          commitment: decimal,
          label: decimal,
          amount: u64,
          refundAuthority: address,
          state: z.enum(["pending", "inserted", "refunded", "skipped"]),
          leafIndex: z.number().int().nullable(),
        })
        .strict(),
    ),
    spends: z.array(
      z
        .object({
          nullifierHash: decimal,
          newCommitment: decimal,
          withdrawnValue: u64,
          destinationOwner: address,
          changeQueueSeq: u64,
        })
        .strict(),
    ),
    exits: z.array(z.object({ nullifierHash: decimal, label: decimal, value: u64 }).strict()),
    approved: z
      .object({
        root: decimal,
        version: u64,
        labels: z.array(decimal),
        consistent: z.boolean(),
        rule: z.string(),
      })
      .strict(),
  })
  .strict();
export type PublicStateWire = z.infer<typeof publicStateWire>;

export const PROTOTYPE_APPROVAL_RULE =
  "Prototype approval rule: the operator approves labels of finalized, inserted deposits whose refund authority is a configured synthetic/test participant. No sanctions or compliance screening is performed or claimed.";
