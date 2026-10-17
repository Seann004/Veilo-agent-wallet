// Rebuilds the program-fixture scenario's deposit, spend and exit instructions with the
// @veilo/privacy-sdk transaction builders, so the LiteSVM suite can execute exactly what the
// wallet and relayer send (programs/privacy-pool/litesvm/tests/sdk_builders.rs).
//   pnpm tsx scripts/sdk-builder-fixtures.ts   (after scripts/program-fixtures.ts)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountRole, getAddressDecoder, getAddressEncoder, type Address, type Instruction } from "@solana/kit";
import {
  associatedTokenAddress,
  bytesToHex,
  depositInstruction,
  exitPublicInstruction,
  fromBe32,
  hexToBytes,
  pendingDepositPda,
  poolStatePda,
  seenPrecommitmentPda,
  spendPrivateInstruction,
  spentNullifierPda,
  pendingChangePda,
  vaultAuthorityPda,
  approvalStatePda,
} from "../packages/privacy-sdk/src/index";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IN = resolve(REPO, "target/program-fixtures/fixtures.json");
const OUT = resolve(REPO, process.argv[2] ?? "target/program-fixtures/sdk-builders.json");

const dec = getAddressDecoder();
const enc = getAddressEncoder();
const hexOf = (a: Address): string => bytesToHex(new Uint8Array(enc.encode(a)));
const A = (hex: string): Address => dec.decode(hexToBytes(hex));
const fe = (hex: string): bigint => fromBe32(hexToBytes(hex));

interface Fx {
  programId: string;
  mint: { address: string };
  keys: Record<string, { address: string }>;
  pools: Record<string, { poolId: string; pool: string }>;
  deposits: Array<{ name: string; owner: string; amount: string; seq: number; precommitment: string; salt: string }>;
  spends: Record<string, { proof: { a: string; b: string; c: string }; stateRoot: string; nullifierHash: string; newCommitment: string; intent: Record<string, string | null> }>;
  exits: Record<string, { proof: { a: string; b: string; c: string }; stateRoot: string; nullifierHash: string; value: string; salt: string; owner: string }>;
}

function wire(ix: Instruction) {
  return {
    programId: hexOf(ix.programAddress),
    accounts: (ix.accounts ?? []).map((m) => ({
      pubkey: hexOf(m.address),
      signer: m.role === AccountRole.READONLY_SIGNER || m.role === AccountRole.WRITABLE_SIGNER,
      writable: m.role === AccountRole.WRITABLE || m.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: bytesToHex(new Uint8Array(ix.data ?? [])),
  };
}

const proof = (p: { a: string; b: string; c: string }) => ({ a: hexToBytes(p.a), b: hexToBytes(p.b), c: hexToBytes(p.c) });

async function main(): Promise<void> {
  const fx = JSON.parse(readFileSync(IN, "utf8")) as Fx;
  const program = A(fx.programId);
  const mint = A(fx.mint.address);
  const key = (name: string) => A(fx.keys[name]!.address);
  const poolState = (await poolStatePda(program, hexToBytes(fx.pools.A!.poolId))).address;
  if (poolState !== A(fx.pools.A!.pool)) throw new Error("pool PDA differs from the fixture");
  const vaultAuthority = (await vaultAuthorityPda(program, poolState)).address;
  const vault = (await associatedTokenAddress(vaultAuthority, mint)).address;
  const approvalState = (await approvalStatePda(program, poolState)).address;
  const payer = key("payer");
  const out: Record<string, Record<string, unknown>> = { deposits: {}, spends: {}, exits: {} };

  for (const d of fx.deposits) {
    const owner = key(d.owner);
    const pre = hexToBytes(d.precommitment);
    out.deposits![d.name] = wire(
      depositInstruction(
        program,
        {
          depositor: owner,
          payer,
          poolState,
          source: (await associatedTokenAddress(owner, mint)).address,
          vault,
          pendingDeposit: (await pendingDepositPda(program, poolState, BigInt(d.seq))).address,
          seenPrecommitment: (await seenPrecommitmentPda(program, poolState, pre)).address,
        },
        { amount: BigInt(d.amount), precommitment: fromBe32(pre), salt: hexToBytes(d.salt) },
      ),
    );
  }

  for (const [name, s] of Object.entries(fx.spends)) {
    const nf = hexToBytes(s.nullifierHash);
    const i = s.intent;
    const relayer = i.relayer === null ? null : A(i.relayer!);
    out.spends![name] = wire(
      spendPrivateInstruction(
        program,
        {
          payer,
          relayer,
          poolState,
          approvalState,
          vault,
          vaultAuthority,
          destination: A(i.destinationTokenAccount!),
          relayerFeeAccount: i.relayerFeeTokenAccount === null ? null : A(i.relayerFeeTokenAccount!),
          spentNullifier: (await spentNullifierPda(program, poolState, nf)).address,
          pendingChange: (await pendingChangePda(program, poolState, nf)).address,
        },
        {
          proof: proof(s.proof),
          stateRoot: fe(s.stateRoot),
          nullifierHash: fe(s.nullifierHash),
          newCommitment: fe(s.newCommitment),
          intent: {
            destinationTokenAccount: hexToBytes(i.destinationTokenAccount!),
            destinationOwner: hexToBytes(i.destinationOwner!),
            payoutAmount: BigInt(i.payoutAmount!),
            relayerFee: BigInt(i.relayerFee!),
            relayer: i.relayer === null ? null : hexToBytes(i.relayer!),
            relayerFeeTokenAccount: i.relayerFeeTokenAccount === null ? null : hexToBytes(i.relayerFeeTokenAccount!),
            validUntilSlot: BigInt(i.validUntilSlot!),
          },
        },
      ),
    );
  }

  for (const [name, e] of Object.entries(fx.exits)) {
    const owner = key(e.owner);
    out.exits![name] = wire(
      exitPublicInstruction(
        program,
        {
          refundAuthority: owner,
          payer,
          poolState,
          vault,
          vaultAuthority,
          destination: (await associatedTokenAddress(owner, mint)).address,
          spentNullifier: (await spentNullifierPda(program, poolState, hexToBytes(e.nullifierHash))).address,
        },
        { proof: proof(e.proof), stateRoot: fe(e.stateRoot), nullifierHash: fe(e.nullifierHash), value: BigInt(e.value), salt: hexToBytes(e.salt) },
      ),
    );
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`wrote ${OUT}: ${Object.keys(out.deposits!).length} deposits, ${Object.keys(out.spends!).length} spends, ${Object.keys(out.exits!).length} exits`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
