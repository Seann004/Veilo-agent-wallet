import { TOKEN_BUCKETS, checkedAdd, checkedSub, type NoteState, type TokenBucket } from "@veilo/contracts";
import { big, type Ledger } from "../context";
import { ControlError } from "../errors";

export interface NoteRow {
  id: string;
  workspace_id: string;
  commitment: string;
  value: bigint;
  origin: "deposit" | "change";
  parent_purchase_id: string | null;
  state: NoteState;
  reserved_purchase_id: string | null;
  consumed_by_purchase_id: string | null;
}

export function appendTokenEvent(
  ledger: Ledger,
  e: {
    workspaceId: string;
    noteId: string | null;
    purchaseId: string | null;
    from: TokenBucket | null;
    to: TokenBucket | null;
    amount: bigint;
    reason: string;
    occurredAtMs?: number;
  },
): void {
  if (e.amount <= 0n) return;
  ledger.db
    .prepare(
      `INSERT INTO token_event (event_id, workspace_id, note_id, purchase_id, from_bucket, to_bucket, amount, reason,
         occurred_at_ms, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ledger.newId(),
      e.workspaceId,
      e.noteId,
      e.purchaseId,
      e.from,
      e.to,
      e.amount,
      e.reason,
      e.occurredAtMs ?? ledger.now(),
      ledger.now(),
    );
}

/** Physical token balances per bucket. Never combined with policy allowance or service credits. */
export function tokenBuckets(ledger: Ledger, workspaceId: string): Record<TokenBucket, bigint> {
  const out = Object.fromEntries(TOKEN_BUCKETS.map((b) => [b, 0n])) as Record<TokenBucket, bigint>;
  const rows = ledger.db
    .prepare(
      `SELECT bucket, sum(inflow) AS inflow, sum(outflow) AS outflow FROM (
         SELECT to_bucket AS bucket, amount AS inflow, 0 AS outflow FROM token_event WHERE workspace_id = ? AND to_bucket IS NOT NULL
         UNION ALL
         SELECT from_bucket AS bucket, 0 AS inflow, amount AS outflow FROM token_event WHERE workspace_id = ? AND from_bucket IS NOT NULL
       ) GROUP BY bucket`,
    )
    .all(workspaceId, workspaceId) as Array<{ bucket: TokenBucket; inflow: bigint; outflow: bigint }>;
  for (const r of rows) out[r.bucket] = checkedSub(big(r.inflow), big(r.outflow));
  return out;
}

/**
 * Registers an approved, inserted deposit note reference (value and commitment only; secrets
 * stay in the wallet secrets database).
 */
export function registerApprovedNote(ledger: Ledger, workspaceId: string, commitment: string, value: bigint): NoteRow {
  const id = ledger.newId();
  const now = ledger.now();
  ledger.db
    .prepare(
      `INSERT INTO note (id, workspace_id, commitment, value, origin, state, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 'deposit', 'approved', ?, ?)`,
    )
    .run(id, workspaceId, commitment, value, now, now);
  appendTokenEvent(ledger, { workspaceId, noteId: id, purchaseId: null, from: null, to: "approved_unreserved", amount: value, reason: "deposit_approved" });
  return ledger.db.prepare(`SELECT * FROM note WHERE id = ?`).get(id) as NoteRow;
}

const SPENDABLE_BUCKET: Partial<Record<NoteState, TokenBucket>> = {
  approved: "approved_unreserved",
  spendable_change: "confirmed_change",
};

/**
 * Reserves the smallest spendable note covering `required` for one purchase. Pending deposits
 * and pending change are never selectable. Throws NOTE_PENDING when nothing is spendable.
 */
export function reserveNote(ledger: Ledger, workspaceId: string, purchaseId: string, required: bigint): NoteRow {
  const note = ledger.db
    .prepare(
      `SELECT * FROM note WHERE workspace_id = ? AND state IN ('approved', 'spendable_change') AND value >= ?
       ORDER BY value, created_at_ms LIMIT 1`,
    )
    .get(workspaceId, required) as NoteRow | undefined;
  if (!note) {
    throw new ControlError("NOTE_PENDING", "no approved spendable pool note covers this purchase; pending change or deposits are not yet usable");
  }
  const r = ledger.db
    .prepare(
      `UPDATE note SET state = 'reserved', reserved_purchase_id = ?, updated_at_ms = ?
       WHERE id = ? AND state IN ('approved', 'spendable_change') AND reserved_purchase_id IS NULL`,
    )
    .run(purchaseId, ledger.now(), note.id);
  if (r.changes !== 1) throw new ControlError("NOTE_PENDING", "note is already reserved by another operation");
  appendTokenEvent(ledger, {
    workspaceId,
    noteId: note.id,
    purchaseId,
    from: SPENDABLE_BUCKET[note.state] ?? "approved_unreserved",
    to: "reserved_input",
    amount: big(note.value),
    reason: "note_reserved",
  });
  return note;
}

export function reservedNoteFor(ledger: Ledger, purchaseId: string): NoteRow | undefined {
  return ledger.db.prepare(`SELECT * FROM note WHERE reserved_purchase_id = ?`).get(purchaseId) as NoteRow | undefined;
}

/** Returns an unreleased reservation's note to its previous spendable state. */
export function unreserveNote(ledger: Ledger, purchaseId: string): void {
  const note = reservedNoteFor(ledger, purchaseId);
  if (!note) return;
  const back: NoteState = note.origin === "change" ? "spendable_change" : "approved";
  ledger.db
    .prepare(`UPDATE note SET state = ?, reserved_purchase_id = NULL, updated_at_ms = ? WHERE id = ? AND state = 'reserved'`)
    .run(back, ledger.now(), note.id);
  appendTokenEvent(ledger, {
    workspaceId: note.workspace_id,
    noteId: note.id,
    purchaseId,
    from: "reserved_input",
    to: SPENDABLE_BUCKET[back] ?? "approved_unreserved",
    amount: big(note.value),
    reason: "note_unreserved",
  });
}

export interface WithdrawalOutcome {
  payout: bigint;
  tokenFees: bigint;
  change: bigint;
  changeCommitment: string | null;
  observedAtMs: number;
}

/**
 * A finalized withdrawal consumes the entire reserved input note exactly once. The remainder
 * becomes a pending change note, unavailable until its insertion is confirmed.
 */
export function consumeReservedNote(ledger: Ledger, purchaseId: string, out: WithdrawalOutcome): NoteRow | null {
  const note = reservedNoteFor(ledger, purchaseId);
  if (!note) throw new ControlError("RECOVERY_REQUIRED", "purchase has no reserved input note");
  const debit = checkedAdd(out.payout, out.tokenFees);
  if (checkedAdd(debit, out.change) !== big(note.value)) {
    throw new ControlError("RECOVERY_REQUIRED", "withdrawal does not conserve the input note value");
  }
  if ((out.change > 0n) !== (out.changeCommitment !== null)) {
    throw new ControlError("RECOVERY_REQUIRED", "change commitment must be present exactly when change is nonzero");
  }
  const now = ledger.now();
  ledger.db
    .prepare(
      `UPDATE note SET state = 'consumed', reserved_purchase_id = NULL, consumed_by_purchase_id = ?, updated_at_ms = ?
       WHERE id = ? AND state = 'reserved'`,
    )
    .run(purchaseId, now, note.id);
  const ws = note.workspace_id;
  const at = out.observedAtMs;
  appendTokenEvent(ledger, { workspaceId: ws, noteId: note.id, purchaseId, from: "reserved_input", to: "consumed", amount: big(note.value), reason: "withdrawal_finalized", occurredAtMs: at });
  appendTokenEvent(ledger, { workspaceId: ws, noteId: null, purchaseId, from: null, to: "payout_balance", amount: out.payout, reason: "fresh_wallet_funded", occurredAtMs: at });
  appendTokenEvent(ledger, { workspaceId: ws, noteId: null, purchaseId, from: null, to: "fee_outflow", amount: out.tokenFees, reason: "withdrawal_token_fee", occurredAtMs: at });
  if (out.change === 0n || out.changeCommitment === null) return null;
  const changeId = ledger.newId();
  ledger.db
    .prepare(
      `INSERT INTO note (id, workspace_id, commitment, value, origin, parent_purchase_id, state, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 'change', ?, 'pending_change', ?, ?)`,
    )
    .run(changeId, ws, out.changeCommitment, out.change, purchaseId, now, now);
  appendTokenEvent(ledger, { workspaceId: ws, noteId: changeId, purchaseId, from: null, to: "pending_change", amount: out.change, reason: "change_enqueued", occurredAtMs: at });
  return ledger.db.prepare(`SELECT * FROM note WHERE id = ?`).get(changeId) as NoteRow;
}

/** Called once authenticated insertion of the change leaf is finalized and a witness is rebuilt. */
export function confirmChangeInserted(ledger: Ledger, purchaseId: string): NoteRow {
  const note = ledger.db
    .prepare(`SELECT * FROM note WHERE parent_purchase_id = ? AND origin = 'change'`)
    .get(purchaseId) as NoteRow | undefined;
  if (!note) throw new ControlError("NOT_FOUND", "purchase has no change note");
  if (note.state !== "pending_change") return note;
  ledger.db.prepare(`UPDATE note SET state = 'spendable_change', updated_at_ms = ? WHERE id = ?`).run(ledger.now(), note.id);
  appendTokenEvent(ledger, {
    workspaceId: note.workspace_id,
    noteId: note.id,
    purchaseId,
    from: "pending_change",
    to: "confirmed_change",
    amount: big(note.value),
    reason: "change_inserted",
  });
  return ledger.db.prepare(`SELECT * FROM note WHERE id = ?`).get(note.id) as NoteRow;
}
