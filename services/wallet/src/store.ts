import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { getAddressDecoder, type Address } from "@solana/kit";
import { immediate, type SqliteDatabase } from "@veilo/db";
import { deriveFieldSecret, deriveOneTimeSeed, deriveSalt, type NoteSecrets } from "@veilo/privacy-sdk";
import { KEY_VERSION, type WalletKeys } from "./secret";

export type CounterName = "note" | "onetime";

export type NoteState =
  | "prepared"
  | "submitted"
  | "finalized"
  | "indexed"
  | "approved"
  | "spendable"
  | "change_prepared"
  | "pending_change"
  | "reserved"
  | "spent"
  | "exit_prepared"
  | "exited"
  | "refunded"
  | "void"
  | "recovery_required";

/** Decrypted note. Held in memory only for proving and never returned over HTTP. */
export interface NoteRecord {
  id: string;
  commitment: string;
  origin: "deposit" | "change";
  parentNoteId: string | null;
  keyIndex: number;
  value: bigint;
  label: bigint;
  nullifierSecret: bigint;
  noteSecret: bigint;
  salt: Uint8Array | null;
  refundAuthority: string | null;
  state: NoteState;
  leafIndex: number | null;
  queueSeq: bigint | null;
  controlRegistered: boolean;
  spendPurchaseId: string | null;
  /** When the note was stored and when its state last changed; absent on records built in memory. */
  createdAtMs?: number;
  updatedAtMs?: number;
}

interface NoteSecretPayload {
  v: 1;
  value: string;
  label: string;
  nullifierSecret: string;
  noteSecret: string;
  salt: string | null;
  refundAuthority: string | null;
}

export interface FundingRow {
  purchase_id: string;
  operation_id: string;
  input_note_id: string;
  change_note_id: string;
  fresh_wallet: string;
  payout: bigint;
  token_fee: bigint;
  sponsor_lamport_cap: bigint;
  nullifier_hash: string;
  valid_until_slot: bigint;
  intent_json: string;
  proof_json: string;
  binding_json: string;
  step: "prepared" | "released" | "submitted" | "finalized" | "expired_unsettled" | "discarded";
  released_at_ms: bigint | null;
  relayer_withdrawal_id: string | null;
  signature: string | null;
  evidence_json: string | null;
  created_at_ms: bigint;
  updated_at_ms: bigint;
}

export interface MerchantPaymentRow {
  purchase_id: string;
  fresh_wallet: string;
  message_hash: string;
  payment_header: string;
  recent_blockhash: string | null;
  amount: bigint;
  state: "signed" | "finalized" | "expired_unsettled";
  settlement_signature: string | null;
  signed_at_ms: bigint;
}

export interface ExternalCallRow {
  purchase_id: string;
  call_index: bigint;
  fresh_wallet: string;
  message_hash: string;
  payment_header: string;
  recent_blockhash: string | null;
  amount: bigint;
  state: "signed" | "finalized" | "expired_unsettled" | "failed";
  settlement_signature: string | null;
  signed_at_ms: bigint;
}

export interface SwapRow {
  purchase_id: string;
  swap_id: string;
  fresh_wallet: string;
  destination: string;
  input_amount: bigint;
  min_out: bigint;
  est_out: bigint;
  transaction_b64: string;
  last_valid_block_height: bigint;
  signature: string | null;
  state: "signed" | "submitted" | "finalized" | "failed" | "expired";
  sponsor_lamports: bigint;
  signed_at_ms: bigint;
}

export interface DepositRow {
  id: string;
  note_id: string;
  owner_pubkey: string;
  amount: bigint;
  blockhash: string;
  last_valid_block_height: bigint;
  message_base64: string;
  signature: string | null;
  state: "prepared" | "submitted" | "finalized" | "expired" | "failed";
}

export interface ExitRow {
  id: string;
  note_id: string;
  owner_pubkey: string;
  nullifier_hash: string;
  value: bigint;
  blockhash: string;
  last_valid_block_height: bigint;
  message_base64: string;
  signature: string | null;
  state: "prepared" | "submitted" | "finalized" | "expired";
}

export interface RecoveryRow {
  id: string;
  purchase_id: string;
  fresh_wallet: string;
  destination_owner: string;
  destination_ata: string;
  amount: bigint;
  rent_destination: string;
  blockhash: string | null;
  last_valid_block_height: bigint | null;
  signature: string | null;
  state: "prepared" | "submitted" | "finalized" | "expired";
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Public key of an Ed25519 seed. */
export function ed25519Address(seed: Uint8Array): Address {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  const x = createPublicKey(priv).export({ format: "jwk" }).x as string;
  return getAddressDecoder().decode(Buffer.from(x, "base64url"));
}

const num = (v: unknown): number => Number(v as bigint);
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v as bigint));

export class WalletStore {
  constructor(
    readonly db: SqliteDatabase,
    private readonly keys: WalletKeys,
    readonly now: () => number = Date.now,
  ) {}

  tx<T>(fn: () => T): T {
    return immediate(this.db, fn);
  }

  // Counters ------------------------------------------------------------------------------

  counter(name: CounterName): number {
    const v = this.db.prepare(`SELECT next_value FROM key_counter WHERE name = ?`).pluck().get(name) as bigint | undefined;
    return v === undefined ? 0 : Number(v);
  }

  /** Allocates the next index durably (committed before it is used for anything). */
  allocate(name: CounterName): number {
    return this.tx(() => {
      const cur = this.counter(name);
      if (this.db.prepare(`SELECT 1 FROM key_counter WHERE name = ?`).get(name) === undefined) {
        this.db.prepare(`INSERT INTO key_counter (name, next_value) VALUES (?, ?)`).run(name, cur + 1);
      } else {
        this.db.prepare(`UPDATE key_counter SET next_value = ? WHERE name = ?`).run(cur + 1, name);
      }
      return cur;
    });
  }

  /** Raises a counter to at least `value` (used by restore to skip possibly-used indices). */
  raiseCounter(name: CounterName, value: number): void {
    this.tx(() => {
      const cur = this.counter(name);
      if (value <= cur) return;
      if (this.db.prepare(`SELECT 1 FROM key_counter WHERE name = ?`).get(name) === undefined) {
        this.db.prepare(`INSERT INTO key_counter (name, next_value) VALUES (?, ?)`).run(name, value);
      } else {
        this.db.prepare(`UPDATE key_counter SET next_value = ? WHERE name = ?`).run(value, name);
      }
    });
  }

  // Events and flags ----------------------------------------------------------------------

  event(kind: string, ref: string | null, detail: Record<string, unknown> = {}): void {
    this.db.prepare(`INSERT INTO wallet_event (kind, ref, detail_json, created_at_ms) VALUES (?, ?, ?, ?)`).run(kind, ref, JSON.stringify(detail), this.now());
  }

  events(ref?: string): Array<{ kind: string; ref: string | null; detail: Record<string, unknown> }> {
    const rows = (ref === undefined
      ? this.db.prepare(`SELECT kind, ref, detail_json FROM wallet_event ORDER BY seq`).all()
      : this.db.prepare(`SELECT kind, ref, detail_json FROM wallet_event WHERE ref = ? ORDER BY seq`).all(ref)) as Array<{ kind: string; ref: string | null; detail_json: string }>;
    return rows.map((r) => ({ kind: r.kind, ref: r.ref, detail: JSON.parse(r.detail_json) as Record<string, unknown> }));
  }

  setFlag(name: string, reason: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO wallet_flag (name, reason, created_at_ms) VALUES (?, ?, ?)`).run(name, reason, this.now());
  }

  clearFlag(name: string): void {
    this.db.prepare(`DELETE FROM wallet_flag WHERE name = ?`).run(name);
  }

  flags(): Array<{ name: string; reason: string }> {
    return this.db.prepare(`SELECT name, reason FROM wallet_flag ORDER BY name`).all() as Array<{ name: string; reason: string }>;
  }

  // Notes ---------------------------------------------------------------------------------

  insertNote(n: {
    origin: "deposit" | "change";
    parentNoteId: string | null;
    keyIndex: number;
    commitment: string;
    value: bigint;
    label: bigint;
    nullifierSecret: bigint;
    noteSecret: bigint;
    salt: Uint8Array | null;
    refundAuthority: string | null;
    state: NoteState;
    spendPurchaseId?: string | null;
  }): string {
    const id = randomUUID();
    const payload: NoteSecretPayload = {
      v: 1,
      value: n.value.toString(),
      label: n.label.toString(),
      nullifierSecret: n.nullifierSecret.toString(),
      noteSecret: n.noteSecret.toString(),
      salt: n.salt === null ? null : Buffer.from(n.salt).toString("hex"),
      refundAuthority: n.refundAuthority,
    };
    const { ciphertext, nonce } = this.keys.seal(Buffer.from(JSON.stringify(payload), "utf8"), `wallet_note:${id}:${n.commitment}`);
    const now = this.now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO wallet_note (id, commitment, origin, parent_note_id, key_index, ciphertext, nonce, key_version, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, n.commitment, n.origin, n.parentNoteId, n.keyIndex, ciphertext, nonce, KEY_VERSION, now);
      this.db
        .prepare(`INSERT INTO wallet_note_status (note_id, state, spend_purchase_id, updated_at_ms) VALUES (?, ?, ?, ?)`)
        .run(id, n.state, n.spendPurchaseId ?? null, now);
    });
    return id;
  }

  private decode(row: Record<string, unknown>): NoteRecord {
    const plain = this.keys.open(row.ciphertext as Buffer, row.nonce as Buffer, `wallet_note:${String(row.id)}:${String(row.commitment)}`);
    const p = JSON.parse(plain.toString("utf8")) as NoteSecretPayload;
    return {
      id: row.id as string,
      commitment: row.commitment as string,
      origin: row.origin as "deposit" | "change",
      parentNoteId: (row.parent_note_id as string | null) ?? null,
      keyIndex: num(row.key_index),
      value: BigInt(p.value),
      label: BigInt(p.label),
      nullifierSecret: BigInt(p.nullifierSecret),
      noteSecret: BigInt(p.noteSecret),
      salt: p.salt === null ? null : new Uint8Array(Buffer.from(p.salt, "hex")),
      refundAuthority: p.refundAuthority,
      state: row.state as NoteState,
      leafIndex: optNum(row.leaf_index),
      queueSeq: row.queue_seq === null ? null : (row.queue_seq as bigint),
      controlRegistered: num(row.control_registered) === 1,
      spendPurchaseId: (row.spend_purchase_id as string | null) ?? null,
      ...(row.created_at_ms !== undefined && row.created_at_ms !== null ? { createdAtMs: num(row.created_at_ms) } : {}),
      ...(row.status_updated_at_ms !== undefined && row.status_updated_at_ms !== null ? { updatedAtMs: num(row.status_updated_at_ms) } : {}),
    };
  }

  private static NOTE_SELECT = `SELECT n.*, s.state, s.leaf_index, s.queue_seq, s.control_registered, s.spend_purchase_id, s.updated_at_ms AS status_updated_at_ms
    FROM wallet_note n JOIN wallet_note_status s ON s.note_id = n.id`;

  note(id: string): NoteRecord | undefined {
    const row = this.db.prepare(`${WalletStore.NOTE_SELECT} WHERE n.id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.decode(row) : undefined;
  }

  noteByCommitment(commitment: string): NoteRecord | undefined {
    const row = this.db.prepare(`${WalletStore.NOTE_SELECT} WHERE n.commitment = ?`).get(commitment) as Record<string, unknown> | undefined;
    return row ? this.decode(row) : undefined;
  }

  notes(states?: readonly NoteState[]): NoteRecord[] {
    const rows = this.db.prepare(`${WalletStore.NOTE_SELECT} ORDER BY n.created_at_ms, n.key_index`).all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.decode(r)).filter((n) => states === undefined || states.includes(n.state));
  }

  /** Public, non-secret note view (no value-bearing secrets). */
  noteStatusRows(): Array<{ id: string; commitment: string; origin: string; state: NoteState; leafIndex: number | null; keyIndex: number }> {
    return (this.db.prepare(`SELECT n.id, n.commitment, n.origin, n.key_index, s.state, s.leaf_index FROM wallet_note n JOIN wallet_note_status s ON s.note_id = n.id ORDER BY n.created_at_ms`).all() as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      commitment: r.commitment as string,
      origin: r.origin as string,
      state: r.state as NoteState,
      leafIndex: optNum(r.leaf_index),
      keyIndex: num(r.key_index),
    }));
  }

  setNoteState(id: string, state: NoteState, extra: { leafIndex?: number; queueSeq?: bigint; controlRegistered?: boolean; reason?: string; spendPurchaseId?: string | null } = {}): void {
    const sets = ["state = ?", "updated_at_ms = ?"];
    const args: unknown[] = [state, this.now()];
    if (extra.leafIndex !== undefined) {
      sets.push("leaf_index = ?");
      args.push(extra.leafIndex);
    }
    if (extra.queueSeq !== undefined) {
      sets.push("queue_seq = ?");
      args.push(extra.queueSeq);
    }
    if (extra.controlRegistered !== undefined) {
      sets.push("control_registered = ?");
      args.push(extra.controlRegistered ? 1 : 0);
    }
    if (extra.reason !== undefined) {
      sets.push("reason = ?");
      args.push(extra.reason);
    }
    if (extra.spendPurchaseId !== undefined) {
      sets.push("spend_purchase_id = ?");
      args.push(extra.spendPurchaseId);
    }
    this.db.prepare(`UPDATE wallet_note_status SET ${sets.join(", ")} WHERE note_id = ?`).run(...args, id);
  }

  maxNoteKeyIndex(): number {
    const v = this.db.prepare(`SELECT max(key_index) FROM wallet_note`).pluck().get() as bigint | null;
    return v === null ? -1 : Number(v);
  }

  /** Protocol HKDF note secrets at index i; null when either is zero (caller skips the index). */
  noteSecretsAt(index: number): NoteSecrets | null {
    const nullifierSecret = deriveFieldSecret(this.keys.noteSeed, "nullifier", index);
    const noteSecret = deriveFieldSecret(this.keys.noteSeed, "secret", index);
    return nullifierSecret === null || noteSecret === null ? null : { nullifierSecret, noteSecret };
  }

  saltAt(index: number): Uint8Array {
    return deriveSalt(this.keys.noteSeed, index);
  }

  /** One-time payment address at counter j (used when matching chain data after a restore). */
  oneTimeAddressAt(index: number): Address {
    return ed25519Address(deriveOneTimeSeed(this.keys.noteSeed, index));
  }

  // Fresh payment wallets -----------------------------------------------------------------

  /**
   * Returns the purchase's one-time payment key, deriving and persisting a new one (and its
   * counter) on first use. The row is committed before any funding refers to the address.
   */
  reserveFreshWallet(purchaseId: string, operationId: string): { address: Address; counter: number; created: boolean } {
    const existing = this.db.prepare(`SELECT public_key, derivation_counter FROM fresh_wallet_key WHERE purchase_id = ?`).get(purchaseId) as
      | { public_key: string; derivation_counter: bigint }
      | undefined;
    if (existing) return { address: existing.public_key as Address, counter: Number(existing.derivation_counter), created: false };
    return this.tx(() => {
      const j = this.allocate("onetime");
      const seed = deriveOneTimeSeed(this.keys.noteSeed, j);
      const addr = ed25519Address(seed);
      const { ciphertext, nonce } = this.keys.seal(seed, `fresh_wallet_key:${purchaseId}:${addr}`);
      this.db
        .prepare(
          `INSERT INTO fresh_wallet_key (purchase_id, operation_id, public_key, derivation_counter, ciphertext, nonce, key_version, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(purchaseId, operationId, addr, j, ciphertext, nonce, KEY_VERSION, this.now());
      this.event("fresh_wallet.reserved", purchaseId, { address: addr, counter: j });
      return { address: addr, counter: j, created: true };
    });
  }

  /** Records a key recovered from the seed (restore path). */
  adoptFreshWallet(purchaseId: string, operationId: string, counter: number): Address {
    const seed = deriveOneTimeSeed(this.keys.noteSeed, counter);
    const addr = ed25519Address(seed);
    const { ciphertext, nonce } = this.keys.seal(seed, `fresh_wallet_key:${purchaseId}:${addr}`);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO fresh_wallet_key (purchase_id, operation_id, public_key, derivation_counter, ciphertext, nonce, key_version, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(purchaseId, operationId, addr, counter, ciphertext, nonce, KEY_VERSION, this.now());
    return addr;
  }

  freshWallets(): Array<{ purchaseId: string; address: string; counter: number }> {
    return (this.db.prepare(`SELECT purchase_id, public_key, derivation_counter FROM fresh_wallet_key ORDER BY derivation_counter`).all() as Array<{ purchase_id: string; public_key: string; derivation_counter: bigint }>).map((r) => ({
      purchaseId: r.purchase_id,
      address: r.public_key,
      counter: Number(r.derivation_counter),
    }));
  }

  /** Decrypts a fresh wallet seed for one signing operation. */
  freshWalletSeed(purchaseId: string): { address: Address; seed: Uint8Array } {
    const row = this.db.prepare(`SELECT public_key, ciphertext, nonce FROM fresh_wallet_key WHERE purchase_id = ?`).get(purchaseId) as
      | { public_key: string; ciphertext: Buffer; nonce: Buffer }
      | undefined;
    if (!row) throw new Error("no fresh wallet for this purchase");
    const seed = new Uint8Array(this.keys.open(row.ciphertext, row.nonce, `fresh_wallet_key:${purchaseId}:${row.public_key}`));
    if (ed25519Address(seed) !== row.public_key) throw new Error("fresh wallet key does not match its address");
    return { address: row.public_key as Address, seed };
  }

  // Fundings ------------------------------------------------------------------------------

  funding(purchaseId: string): FundingRow | undefined {
    return this.db.prepare(`SELECT * FROM funding WHERE purchase_id = ?`).get(purchaseId) as FundingRow | undefined;
  }

  fundings(steps?: readonly FundingRow["step"][]): FundingRow[] {
    const rows = this.db.prepare(`SELECT * FROM funding ORDER BY created_at_ms`).all() as FundingRow[];
    return steps ? rows.filter((r) => steps.includes(r.step)) : rows;
  }

  insertFunding(f: Omit<FundingRow, "step" | "released_at_ms" | "relayer_withdrawal_id" | "signature" | "evidence_json" | "created_at_ms" | "updated_at_ms">): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO funding (purchase_id, operation_id, input_note_id, change_note_id, fresh_wallet, payout, token_fee, sponsor_lamport_cap,
           nullifier_hash, valid_until_slot, intent_json, proof_json, binding_json, step, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      )
      .run(
        f.purchase_id,
        f.operation_id,
        f.input_note_id,
        f.change_note_id,
        f.fresh_wallet,
        f.payout,
        f.token_fee,
        f.sponsor_lamport_cap,
        f.nullifier_hash,
        f.valid_until_slot,
        f.intent_json,
        f.proof_json,
        f.binding_json,
        now,
        now,
      );
  }

  updateFunding(purchaseId: string, set: Partial<Pick<FundingRow, "step" | "released_at_ms" | "relayer_withdrawal_id" | "signature" | "evidence_json">>): void {
    const keys = Object.keys(set) as Array<keyof typeof set>;
    if (keys.length === 0) return;
    this.db
      .prepare(`UPDATE funding SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at_ms = ? WHERE purchase_id = ?`)
      .run(...keys.map((k) => set[k] ?? null), this.now(), purchaseId);
  }

  // Merchant payments ---------------------------------------------------------------------

  merchantPayment(purchaseId: string): MerchantPaymentRow | undefined {
    return this.db.prepare(`SELECT * FROM merchant_payment WHERE purchase_id = ?`).get(purchaseId) as MerchantPaymentRow | undefined;
  }

  insertMerchantPayment(m: Omit<MerchantPaymentRow, "state" | "settlement_signature" | "signed_at_ms">): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO merchant_payment (purchase_id, fresh_wallet, message_hash, payment_header, recent_blockhash, amount, state, signed_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'signed', ?, ?)`,
      )
      .run(m.purchase_id, m.fresh_wallet, m.message_hash, m.payment_header, m.recent_blockhash, m.amount, now, now);
  }

  updateMerchantPayment(purchaseId: string, state: MerchantPaymentRow["state"], settlementSignature: string | null): void {
    this.db
      .prepare(`UPDATE merchant_payment SET state = ?, settlement_signature = ifnull(?, settlement_signature), updated_at_ms = ? WHERE purchase_id = ?`)
      .run(state, settlementSignature, this.now(), purchaseId);
  }

  externalCalls(purchaseId: string): ExternalCallRow[] {
    return this.db.prepare(`SELECT * FROM external_call WHERE purchase_id = ? ORDER BY call_index`).all(purchaseId) as ExternalCallRow[];
  }

  insertExternalCall(c: Omit<ExternalCallRow, "state" | "settlement_signature" | "signed_at_ms">): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO external_call (purchase_id, call_index, fresh_wallet, message_hash, payment_header, recent_blockhash, amount, state, signed_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'signed', ?, ?)`,
      )
      .run(c.purchase_id, c.call_index, c.fresh_wallet, c.message_hash, c.payment_header, c.recent_blockhash, c.amount, now, now);
  }

  updateExternalCall(purchaseId: string, callIndex: number, state: ExternalCallRow["state"], settlementSignature: string | null): void {
    this.db
      .prepare(
        `UPDATE external_call SET state = ?, settlement_signature = ifnull(?, settlement_signature), updated_at_ms = ?
         WHERE purchase_id = ? AND call_index = ? AND state = 'signed'`,
      )
      .run(state, settlementSignature, this.now(), purchaseId, callIndex);
  }

  // Swaps ---------------------------------------------------------------------------------

  swap(purchaseId: string): SwapRow | undefined {
    return this.db.prepare(`SELECT * FROM swap WHERE purchase_id = ?`).get(purchaseId) as SwapRow | undefined;
  }

  insertSwap(s: Omit<SwapRow, "state" | "signature" | "sponsor_lamports" | "signed_at_ms">): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO swap (purchase_id, swap_id, fresh_wallet, destination, input_amount, min_out, est_out, transaction_b64, last_valid_block_height, state, signed_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'signed', ?, ?)`,
      )
      .run(s.purchase_id, s.swap_id, s.fresh_wallet, s.destination, s.input_amount, s.min_out, s.est_out, s.transaction_b64, s.last_valid_block_height, now, now);
  }

  updateSwap(purchaseId: string, f: { state: SwapRow["state"]; signature?: string | null; sponsorLamports?: bigint }): void {
    this.db
      .prepare(`UPDATE swap SET state = ?, signature = ifnull(?, signature), sponsor_lamports = ifnull(?, sponsor_lamports), updated_at_ms = ? WHERE purchase_id = ?`)
      .run(f.state, f.signature ?? null, f.sponsorLamports ?? null, this.now(), purchaseId);
  }

  // Deposits, exits, recoveries -----------------------------------------------------------

  insertDeposit(d: Omit<DepositRow, "signature" | "state">): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO deposit_request (id, note_id, owner_pubkey, amount, blockhash, last_valid_block_height, message_base64, state, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      )
      .run(d.id, d.note_id, d.owner_pubkey, d.amount, d.blockhash, d.last_valid_block_height, d.message_base64, now, now);
  }

  deposit(id: string): DepositRow | undefined {
    return this.db.prepare(`SELECT * FROM deposit_request WHERE id = ?`).get(id) as DepositRow | undefined;
  }

  deposits(states?: readonly DepositRow["state"][]): DepositRow[] {
    const rows = this.db.prepare(`SELECT * FROM deposit_request ORDER BY created_at_ms`).all() as DepositRow[];
    return states ? rows.filter((r) => states.includes(r.state)) : rows;
  }

  updateDeposit(id: string, set: { state?: DepositRow["state"]; signature?: string }): void {
    this.db
      .prepare(`UPDATE deposit_request SET state = ifnull(?, state), signature = ifnull(?, signature), updated_at_ms = ? WHERE id = ?`)
      .run(set.state ?? null, set.signature ?? null, this.now(), id);
  }

  insertExit(e: Omit<ExitRow, "signature" | "state">): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO exit_request (id, note_id, owner_pubkey, nullifier_hash, value, blockhash, last_valid_block_height, message_base64, state, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      )
      .run(e.id, e.note_id, e.owner_pubkey, e.nullifier_hash, e.value, e.blockhash, e.last_valid_block_height, e.message_base64, now, now);
  }

  exit(id: string): ExitRow | undefined {
    return this.db.prepare(`SELECT * FROM exit_request WHERE id = ?`).get(id) as ExitRow | undefined;
  }

  exits(states?: readonly ExitRow["state"][]): ExitRow[] {
    const rows = this.db.prepare(`SELECT * FROM exit_request ORDER BY created_at_ms`).all() as ExitRow[];
    return states ? rows.filter((r) => states.includes(r.state)) : rows;
  }

  updateExit(id: string, set: { state?: ExitRow["state"]; signature?: string }): void {
    this.db
      .prepare(`UPDATE exit_request SET state = ifnull(?, state), signature = ifnull(?, signature), updated_at_ms = ? WHERE id = ?`)
      .run(set.state ?? null, set.signature ?? null, this.now(), id);
  }

  insertRecovery(r: Omit<RecoveryRow, "signature" | "state" | "blockhash" | "last_valid_block_height">): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO recovery_request (id, purchase_id, fresh_wallet, destination_owner, destination_ata, amount, rent_destination, state, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      )
      .run(r.id, r.purchase_id, r.fresh_wallet, r.destination_owner, r.destination_ata, r.amount, r.rent_destination, now, now);
  }

  recovery(id: string): RecoveryRow | undefined {
    return this.db.prepare(`SELECT * FROM recovery_request WHERE id = ?`).get(id) as RecoveryRow | undefined;
  }

  recoveries(states?: readonly RecoveryRow["state"][]): RecoveryRow[] {
    const rows = this.db.prepare(`SELECT * FROM recovery_request ORDER BY created_at_ms`).all() as RecoveryRow[];
    return states ? rows.filter((r) => states.includes(r.state)) : rows;
  }

  updateRecovery(id: string, set: { state?: RecoveryRow["state"]; signature?: string; blockhash?: string; lastValidBlockHeight?: bigint }): void {
    this.db
      .prepare(
        `UPDATE recovery_request SET state = ifnull(?, state), signature = ifnull(?, signature), blockhash = ifnull(?, blockhash),
           last_valid_block_height = ifnull(?, last_valid_block_height), updated_at_ms = ? WHERE id = ?`,
      )
      .run(set.state ?? null, set.signature ?? null, set.blockhash ?? null, set.lastValidBlockHeight ?? null, this.now(), id);
  }
}
