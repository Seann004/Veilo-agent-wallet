import type { Address } from "@solana/kit";
import type { PublicStateWire, RecoveryRequestWire, RecoveryViewWire, WithdrawalRequestWire, WithdrawalViewWire } from "@veilo/contracts/relayer";
import type { CircuitWitness, DeploymentManifest, GeneratedProof } from "@veilo/privacy-sdk";

/** Control purchase view (subset of `purchaseView`). */
export interface ControlPurchase {
  id: string;
  operationId: string;
  agentId: string;
  paymentPath: string;
  price: { amount: string };
  feeCap: { amount: string };
  sponsorReservation: { amount: string };
  states: { authorization: string; funding: string; merchant: string; fulfilment: string; recovery: string };
  reservation: { status: string };
  epochs: { agent: number; stop: number };
}

export interface LivePurchaseRef {
  id: string;
  authorization: string;
  funding: string;
  merchant: string;
  recovery: string;
  reservedNoteCommitment: string | null;
}

export interface ControlNoteRef {
  commitment: string;
  value: string;
  state: string;
  origin: string;
  reservedPurchaseId: string | null;
  parentPurchaseId: string | null;
}

/** Wallet's view of the authoritative control ledger (wallet service credential). */
export interface ControlPort {
  purchase(purchaseId: string): Promise<ControlPurchase>;
  ownerSession(sessionToken: string, csrfToken: string | undefined): Promise<{ workspaceId: string; ownerPubkey: string; csrfValid: boolean }>;
  registerDepositNote(commitment: string, value: bigint): Promise<void>;
  confirmChange(purchaseId: string): Promise<void>;
  noteExited(commitment: string, observedAtMs: number): Promise<void>;
  merchantExpired(purchaseId: string): Promise<ControlPurchase>;
  markRecoverable(purchaseId: string, reason: string): Promise<ControlPurchase>;
  recordRecovery(purchaseId: string, r: { recoveredPrincipal: bigint; tokenFeesPaid: bigint; sponsorLamportsSpent: bigint; observedAtMs: number }): Promise<void>;
  livePurchases(): Promise<LivePurchaseRef[]>;
  notes(): Promise<ControlNoteRef[]>;
}

export interface RelayerPort {
  deployment(): Promise<DeploymentManifest>;
  publicState(): Promise<PublicStateWire>;
  submitWithdrawal(req: WithdrawalRequestWire): Promise<WithdrawalViewWire>;
  withdrawal(withdrawalId: string): Promise<WithdrawalViewWire | null>;
  submitRecovery(req: RecoveryRequestWire): Promise<RecoveryViewWire>;
  recovery(recoveryId: string): Promise<RecoveryViewWire | null>;
}

export interface SignatureStatus {
  confirmationStatus: "processed" | "confirmed" | "finalized";
  err: unknown;
  slot: bigint;
}

/** Read-only chain access. All reads are at finalized commitment unless stated. */
export interface ChainPort {
  finalizedSlot(): Promise<bigint>;
  finalizedBlockHeight(): Promise<bigint>;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  account(addr: Address): Promise<{ data: Uint8Array; lamports: bigint; owner: string } | null>;
  tokenBalance(ata: Address): Promise<bigint | null>;
  signatureStatus(signature: string): Promise<SignatureStatus | null>;
  isBlockhashValid(blockhash: string): Promise<boolean>;
  /** Finds a transaction touching `addr` whose message hash equals `messageHash`. */
  findTransaction(addr: Address, messageHash: string): Promise<{ signature: string; err: unknown; finalized: boolean } | null>;
}

export interface ProverPort {
  prove(circuit: "spend" | "exit", witness: CircuitWitness): Promise<GeneratedProof>;
}

export class PortUnavailableError extends Error {
  override readonly name = "PortUnavailableError";
}
