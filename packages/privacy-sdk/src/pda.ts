import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { assertBytes32, assertU64 } from "./field";

export const TOKEN_PROGRAM_ID = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export interface Pda {
  address: Address;
  bump: number;
}

const enc = getAddressEncoder();
const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

function u64Le(x: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, assertU64(x, "queue sequence"), true);
  return out;
}

async function find(programAddress: Address, seeds: Uint8Array[]): Promise<Pda> {
  const [pda, bump] = await getProgramDerivedAddress({ programAddress, seeds });
  return { address: pda, bump };
}

export function poolStatePda(program: Address, poolId: Uint8Array): Promise<Pda> {
  return find(program, [utf8("pool"), assertBytes32(poolId, "pool id")]);
}

export function vaultAuthorityPda(program: Address, pool: Address): Promise<Pda> {
  return find(program, [utf8("vault_authority"), enc.encode(pool) as Uint8Array]);
}

export function pendingDepositPda(program: Address, pool: Address, queueSeq: bigint): Promise<Pda> {
  return find(program, [utf8("deposit"), enc.encode(pool) as Uint8Array, u64Le(queueSeq)]);
}

export function seenPrecommitmentPda(program: Address, pool: Address, precommitmentBe32: Uint8Array): Promise<Pda> {
  return find(program, [utf8("precommitment"), enc.encode(pool) as Uint8Array, assertBytes32(precommitmentBe32, "precommitment")]);
}

export function pendingChangePda(program: Address, pool: Address, nullifierHashBe32: Uint8Array): Promise<Pda> {
  return find(program, [utf8("change"), enc.encode(pool) as Uint8Array, assertBytes32(nullifierHashBe32, "nullifier hash")]);
}

export function spentNullifierPda(program: Address, pool: Address, nullifierHashBe32: Uint8Array): Promise<Pda> {
  return find(program, [utf8("nullifier"), enc.encode(pool) as Uint8Array, assertBytes32(nullifierHashBe32, "nullifier hash")]);
}

export function approvalStatePda(program: Address, pool: Address): Promise<Pda> {
  return find(program, [utf8("approval"), enc.encode(pool) as Uint8Array]);
}

/** Associated token account of `owner` for `mint` under the original SPL Token program. */
export function associatedTokenAddress(owner: Address, mint: Address): Promise<Pda> {
  return find(ASSOCIATED_TOKEN_PROGRAM_ID, [
    enc.encode(owner) as Uint8Array,
    enc.encode(TOKEN_PROGRAM_ID) as Uint8Array,
    enc.encode(mint) as Uint8Array,
  ]);
}
