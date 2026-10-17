import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AccountRole, address, getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  accountDiscriminator,
  addressBytes,
  bytesToHex,
  decodePoolEvent,
  encodePoolEvent,
  exitPublicInstruction,
  insertLeafInstruction,
  instructionDiscriminator,
  parsePoolEventsFromLogs,
  POOL_INSTRUCTION_ACCOUNTS,
  POOL_INSTRUCTION_ARGS,
  POOL_INSTRUCTIONS,
  spendPrivateInstruction,
  depositInstruction,
  decodePoolState,
  ACCOUNT_SIZES,
  BorshWriter,
  toBe32,
  type PoolEvent,
  type WithdrawalIntent,
} from "../src/index";

const PROGRAM = address("CVDFLCAjXhVWiPXH9nTCTpCgVzmDVoiPzNJYuccr1dqB");
/** Deterministic distinct addresses from fixed bytes. */
const A = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));

const proof = { a: new Uint8Array(64).fill(1), b: new Uint8Array(128).fill(2), c: new Uint8Array(64).fill(3) };

function intent(relayer: boolean, fee = 0n): WithdrawalIntent {
  return {
    destinationTokenAccount: addressBytes(A(0x55)),
    destinationOwner: addressBytes(A(0x66)),
    payoutAmount: 1_000_000n,
    relayerFee: fee,
    relayer: relayer ? addressBytes(A(0x77)) : null,
    relayerFeeTokenAccount: fee > 0n ? addressBytes(A(0x88)) : null,
    validUntilSlot: 400_000_750n,
  };
}

describe("anchor discriminators", () => {
  it("match the Anchor sha256 namespace rule", () => {
    // Well-known Anchor value for `global:initialize`.
    expect(bytesToHex(instructionDiscriminator("initialize"))).toBe("afaf6d1f0d989bed");
    expect(accountDiscriminator("PoolState")).toHaveLength(8);
  });
});

describe("instruction builders", () => {
  it("encode spend_private with the protocol size (514 bytes with relayer and fee account)", () => {
    const accounts = {
      payer: A(0x99),
      relayer: A(0x77),
      poolState: A(0x11),
      approvalState: A(0x12),
      vault: A(0x13),
      vaultAuthority: A(0x14),
      destination: A(0x55),
      relayerFeeAccount: A(0x88),
      spentNullifier: A(0x15),
      pendingChange: A(0x16),
    };
    const ix = spendPrivateInstruction(PROGRAM, accounts, { proof, stateRoot: 5n, nullifierHash: 6n, newCommitment: 7n, intent: intent(true, 10n) });
    expect(ix.data).toHaveLength(514);
    expect(ix.accounts).toHaveLength(POOL_INSTRUCTION_ACCOUNTS.spend_private.length);
    expect(Array.from(ix.data!.subarray(0, 8))).toEqual(Array.from(instructionDiscriminator("spend_private")));
    // Field elements are raw big-endian 32 bytes after the 256-byte proof.
    expect(Array.from(ix.data!.subarray(264, 296))).toEqual(Array.from(toBe32(5n)));
    expect(ix.accounts![0]!.role).toBe(AccountRole.WRITABLE_SIGNER);
    expect(ix.accounts![1]!.role).toBe(AccountRole.READONLY_SIGNER);
  });

  it("passes the program id for absent optional accounts and refuses a mismatched relayer", () => {
    const base = {
      payer: A(0x99),
      relayer: null,
      poolState: A(0x11),
      approvalState: A(0x12),
      vault: A(0x13),
      vaultAuthority: A(0x14),
      destination: A(0x55),
      relayerFeeAccount: null,
      spentNullifier: A(0x15),
      pendingChange: A(0x16),
    };
    const ix = spendPrivateInstruction(PROGRAM, base, { proof, stateRoot: 1n, nullifierHash: 2n, newCommitment: 3n, intent: intent(false) });
    expect(ix.accounts![1]!.address).toBe(PROGRAM);
    expect(ix.accounts![7]!.address).toBe(PROGRAM);
    expect(ix.data).toHaveLength(8 + 256 + 96 + 32 + 32 + 8 + 8 + 1 + 1 + 8);
    expect(() => spendPrivateInstruction(PROGRAM, base, { proof, stateRoot: 1n, nullifierHash: 2n, newCommitment: 3n, intent: intent(true) })).toThrow(/relayer/);
    expect(() =>
      spendPrivateInstruction(PROGRAM, { ...base, destination: A(0x56) }, { proof, stateRoot: 1n, nullifierHash: 2n, newCommitment: 3n, intent: intent(false) }),
    ).toThrow(/destination/);
    expect(() => spendPrivateInstruction(PROGRAM, base, { proof, stateRoot: 1n, nullifierHash: 2n, newCommitment: 0n, intent: intent(false) })).toThrow();
  });

  it("encodes exit, deposit and insert arguments in protocol order", () => {
    const exit = exitPublicInstruction(
      PROGRAM,
      { refundAuthority: A(1), payer: A(1), poolState: A(2), vault: A(3), vaultAuthority: A(4), destination: A(5), spentNullifier: A(6) },
      { proof, stateRoot: 9n, nullifierHash: 8n, value: 7n, salt: new Uint8Array(32).fill(4) },
    );
    expect(exit.data).toHaveLength(8 + 256 + 64 + 8 + 32);
    expect(exit.accounts![0]!.role).toBe(AccountRole.WRITABLE_SIGNER);
    const dep = depositInstruction(
      PROGRAM,
      { depositor: A(1), payer: A(1), poolState: A(2), source: A(3), vault: A(4), pendingDeposit: A(5), seenPrecommitment: A(6) },
      { amount: 100_000n, precommitment: 42n, salt: new Uint8Array(32) },
    );
    expect(dep.data).toHaveLength(8 + 8 + 32 + 32);
    expect(() => insertLeafInstruction(PROGRAM, { submitter: A(1), poolState: A(2), pendingDeposit: null, pendingChange: null }, { proof, newRoot: 1n })).toThrow();
  });
});

describe("accounts and events", () => {
  it("decodes a PoolState of the protocol size and rejects other sizes", () => {
    const w = new BorshWriter().bytes(accountDiscriminator("PoolState"));
    w.u8(1).u8(254).u8(253).u8(6).bool(false).u8(1).u8(1).bytes(new Uint8Array(32).fill(1));
    for (let i = 0; i < 4; i++) w.pubkey(A(i + 2));
    w.bytes(toBe32(0n)); // genesis placeholder
    w.bytes(toBe32(77n));
    for (let i = 0; i < 32; i++) w.bytes(toBe32(i === 0 ? 77n : 0n));
    for (let i = 0; i < 10; i++) w.u64(BigInt(i));
    w.bytes(new Uint8Array(64));
    const data = w.finish();
    expect(data).toHaveLength(ACCOUNT_SIZES.PoolState);
    const pool = decodePoolState(data);
    expect(pool.currentRoot).toBe(77n);
    expect(pool.liability).toBe(3n);
    expect(() => decodePoolState(data.subarray(1))).toThrow();
  });

  it("round-trips events and only accepts data logged while the pool program executes", () => {
    const ev: PoolEvent = { name: "QueueItemSkipped", pool: A(9), queueSeq: 4n };
    const spend: PoolEvent = {
      name: "PrivateSpend",
      pool: A(9),
      nullifierHash: 1n,
      stateRoot: 2n,
      approvedRoot: 3n,
      withdrawnValue: 10n,
      payoutAmount: 10n,
      relayerFee: 0n,
      destinationTokenAccount: A(5),
      destinationOwner: A(6),
      relayer: null,
      validUntilSlot: 99n,
      newCommitment: 4n,
      changeQueueSeq: 5n,
      liability: 0n,
    };
    for (const e of [ev, spend]) expect(decodePoolEvent(encodePoolEvent(e))).toEqual(e);
    const b64 = Buffer.from(encodePoolEvent(ev)).toString("base64");
    const logs = [
      `Program ${PROGRAM} invoke [1]`,
      `Program data: ${b64}`,
      `Program ${A(42)} invoke [2]`,
      `Program data: ${b64}`,
      `Program ${A(42)} success`,
      `Program ${PROGRAM} success`,
      `Program data: ${b64}`,
    ];
    expect(parsePoolEventsFromLogs(PROGRAM, logs)).toEqual([ev]);
  });
});

const IDL_PATH = resolve(import.meta.dirname, "../../../artifacts/program/privacy_pool.json");

interface IdlInstruction {
  name: string;
  discriminator?: number[];
  accounts: Array<{ name: string }>;
  args: Array<{ name: string }>;
}

describe("program IDL agreement", () => {
  it.skipIf(!existsSync(IDL_PATH))("builders match artifacts/program/privacy_pool.json", () => {
    const idl = JSON.parse(readFileSync(IDL_PATH, "utf8")) as { instructions: IdlInstruction[] };
    for (const name of POOL_INSTRUCTIONS) {
      const entry = idl.instructions.find((i) => i.name === name);
      expect(entry, `IDL lacks ${name}`).toBeDefined();
      if (entry!.discriminator) expect(entry!.discriminator).toEqual(Array.from(instructionDiscriminator(name)));
      expect(entry!.accounts.map((a) => a.name)).toEqual(POOL_INSTRUCTION_ACCOUNTS[name]);
      expect(entry!.args.map((a) => a.name)).toEqual(POOL_INSTRUCTION_ARGS[name]);
    }
  });
});

describe("account encoders", () => {
  it("round-trip through the decoders", async () => {
    const { encodeApprovalState, decodeApprovalState, encodeSpentNullifier, decodeSpentNullifier } = await import("../src/index");
    const appr = { pool: A(1), approvalAuthority: A(2), approvedRoot: 99n, version: 3n, updatedSlot: 4n, bump: 250 };
    expect(decodeApprovalState(encodeApprovalState(appr))).toEqual(appr);
    const nf = { pool: A(1), kind: "exit" as const, slot: 5n, bump: 1 };
    expect(decodeSpentNullifier(encodeSpentNullifier(nf))).toEqual(nf);
  });
});

describe("program IDL agreement (roles and layouts)", () => {
  interface IdlAccount { name: string; signer?: boolean; writable?: boolean; optional?: boolean }
  interface IdlType { name: string; type: { fields?: Array<{ name: string }> } }
  const EVENT_FIELDS: Record<string, string[]> = {
    PoolInitialized: ["pool", "pool_id", "mint", "token_program", "vault", "genesis_hash", "empty_root", "config_authority", "approval_authority", "protocol_version"],
    DepositQueued: ["pool", "queue_seq", "amount", "refund_authority", "salt", "label", "precommitment", "commitment", "liability"],
    DepositRefunded: ["pool", "queue_seq", "amount", "refund_authority", "destination", "liability"],
    LeafInserted: ["pool", "queue_seq", "kind", "leaf_index", "commitment", "new_root"],
    QueueItemSkipped: ["pool", "queue_seq"],
    ApprovedRootUpdated: ["pool", "version", "approved_root"],
    PrivateSpend: ["pool", "nullifier_hash", "state_root", "approved_root", "withdrawn_value", "payout_amount", "relayer_fee", "destination_token_account", "destination_owner", "relayer", "valid_until_slot", "new_commitment", "change_queue_seq", "liability"],
    PublicExit: ["pool", "nullifier_hash", "state_root", "label", "value", "refund_authority", "destination", "liability"],
    ConfigUpdated: ["pool", "deposits_paused", "min_deposit", "max_deposit", "liability_cap", "max_relayer_fee"],
    WithdrawalIntent: ["destination_token_account", "destination_owner", "payout_amount", "relayer_fee", "relayer", "relayer_fee_token_account", "valid_until_slot"],
    Groth16Proof: ["a", "b", "c"],
  };
  const ROLES: Record<string, Record<string, string>> = {
    spend_private: { payer: "sw", relayer: "s?", approval_state: "", destination: "w", relayer_fee_account: "w?", spent_nullifier: "w", pending_change: "w" },
    exit_public: { refund_authority: "s", payer: "sw", destination: "w", spent_nullifier: "w" },
    deposit: { depositor: "s", payer: "sw", source: "w", pending_deposit: "w", seen_precommitment: "w" },
    insert_leaf: { submitter: "s", pool_state: "w", pending_deposit: "w?", pending_change: "w?" },
    update_approved_root: { approval_authority: "s", pool_state: "", approval_state: "w" },
  };

  it.skipIf(!existsSync(IDL_PATH))("signer/writable/optional flags and type field order match the builders and decoders", () => {
    const idl = JSON.parse(readFileSync(IDL_PATH, "utf8")) as { instructions: Array<{ name: string; accounts: IdlAccount[] }>; types: IdlType[] };
    for (const [ixName, roles] of Object.entries(ROLES)) {
      const ix = idl.instructions.find((i) => i.name === ixName)!;
      for (const [acct, role] of Object.entries(roles)) {
        const a = ix.accounts.find((x) => x.name === acct)!;
        const got = `${a.signer ? "s" : ""}${a.writable ? "w" : ""}${a.optional ? "?" : ""}`;
        expect(got, `${ixName}.${acct}`).toBe(role);
      }
    }
    for (const [name, fields] of Object.entries(EVENT_FIELDS)) {
      const t = idl.types.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect(t!.type.fields!.map((f) => f.name), name).toEqual(fields);
    }
  });
});
