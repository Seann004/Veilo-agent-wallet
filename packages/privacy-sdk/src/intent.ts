import { assertBytes32, concatBytes, EncodingError, u64Be, U64_MAX } from "./field";
import { ascii, INTENT_DOMAIN, sha256, sha256First31 } from "./label";

export const MAX_INTENT_SLOTS = 750n;

/** Mirrors the on-chain `WithdrawalIntent`. Keys are raw 32-byte addresses; amounts and slots are u64. */
export interface WithdrawalIntent {
  destinationTokenAccount: Uint8Array;
  destinationOwner: Uint8Array;
  payoutAmount: bigint;
  relayerFee: bigint;
  relayer: Uint8Array | null;
  relayerFeeTokenAccount: Uint8Array | null;
  validUntilSlot: bigint;
}

/** Values the program reads from its own id and PoolState, never from the instruction. */
export interface IntentContextFields {
  programId: Uint8Array;
  pool: Uint8Array;
  genesisHash: Uint8Array;
  mint: Uint8Array;
}

export const INTENT_BYTES_LENGTH = 296;

const ZERO32 = new Uint8Array(32);

export function intentBytes(ctx: IntentContextFields, intent: WithdrawalIntent): Uint8Array {
  const out = concatBytes(
    ascii(INTENT_DOMAIN),
    assertBytes32(ctx.programId, "program id"),
    assertBytes32(ctx.pool, "pool"),
    assertBytes32(ctx.genesisHash, "genesis hash"),
    assertBytes32(ctx.mint, "mint"),
    assertBytes32(intent.destinationTokenAccount, "destination token account"),
    assertBytes32(intent.destinationOwner, "destination owner"),
    u64Be(intent.payoutAmount),
    u64Be(intent.relayerFee),
    Uint8Array.of(intent.relayer === null ? 0 : 1),
    intent.relayer === null ? ZERO32 : assertBytes32(intent.relayer, "relayer"),
    intent.relayerFeeTokenAccount === null
      ? ZERO32
      : assertBytes32(intent.relayerFeeTokenAccount, "relayer fee token account"),
    u64Be(intent.validUntilSlot),
  );
  if (out.length !== INTENT_BYTES_LENGTH) throw new EncodingError("intent encoding length mismatch");
  return out;
}

export interface IntentDerivation {
  bytes: Uint8Array;
  sha256: Uint8Array;
  context: bigint;
  withdrawnValue: bigint;
}

export function intentContext(ctx: IntentContextFields, intent: WithdrawalIntent): IntentDerivation {
  const bytes = intentBytes(ctx, intent);
  return {
    bytes,
    sha256: sha256(bytes),
    context: sha256First31(bytes),
    withdrawnValue: withdrawnValue(intent),
  };
}

/** payout + fee as a checked u64 (the spend circuit's withdrawnValue). */
export function withdrawnValue(intent: WithdrawalIntent): bigint {
  const total = intent.payoutAmount + intent.relayerFee;
  if (total > U64_MAX) throw new IntentError("AmountOverflow", "payout + relayer fee overflows u64");
  return total;
}

export type IntentErrorCode =
  | "PayoutZero"
  | "AmountOverflow"
  | "RelayerFeeNotAllowed"
  | "RelayerFeeAccountMismatch"
  | "IntentExpired"
  | "IntentTooFarInFuture";

export class IntentError extends Error {
  override readonly name = "IntentError";
  constructor(
    readonly code: IntentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Pre-checks the program's intent rules 1, 2, 3 (structural part), 4 and 5. Rule 3's signer and
 * token-account ownership checks need chain state and are not covered here.
 */
export function validateIntent(intent: WithdrawalIntent, maxRelayerFee: bigint, currentSlot: bigint): void {
  if (intent.payoutAmount <= 0n) throw new IntentError("PayoutZero", "payout amount must be > 0");
  u64Be(intent.payoutAmount);
  u64Be(intent.relayerFee);
  u64Be(intent.validUntilSlot);
  withdrawnValue(intent);
  if (intent.relayer === null) {
    if (intent.relayerFee !== 0n) throw new IntentError("RelayerFeeNotAllowed", "relayer fee without relayer");
    if (intent.relayerFeeTokenAccount !== null) {
      throw new IntentError("RelayerFeeAccountMismatch", "relayer fee account without relayer");
    }
  } else if ((intent.relayerFee > 0n) !== (intent.relayerFeeTokenAccount !== null)) {
    throw new IntentError("RelayerFeeAccountMismatch", "relayer fee account must be present iff relayer fee > 0");
  }
  if (intent.relayerFee > maxRelayerFee) throw new IntentError("RelayerFeeNotAllowed", "relayer fee above pool maximum");
  if (currentSlot > intent.validUntilSlot) throw new IntentError("IntentExpired", "intent expired");
  if (intent.validUntilSlot - currentSlot > MAX_INTENT_SLOTS) {
    throw new IntentError("IntentTooFarInFuture", "valid_until_slot is more than 750 slots ahead");
  }
}
