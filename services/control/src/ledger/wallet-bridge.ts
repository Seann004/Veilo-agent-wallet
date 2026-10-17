import { immediate } from "@veilo/db";
import { big, type Ledger } from "../context";
import { ControlError } from "../errors";
import { writeAudit } from "./events";
import { appendTokenEvent, confirmChangeInserted, registerApprovedNote, type NoteRow } from "./notes";
import { getPurchaseRow, markRecoverable, recordExternalRecovery, transition, type PurchaseRow } from "./purchases";
import { requireWorkspace } from "./workspace";

/**
 * Wallet-service writes to the authoritative ledger. The wallet supplies only public note
 * references (commitment, value) and chain evidence; secrets never reach control.
 */

/** Registers an approved, inserted deposit note once; a repeated call returns the same row. */
export function registerWalletDepositNote(ledger: Ledger, commitment: string, value: bigint): { note: NoteRow; created: boolean } {
  return immediate(ledger.db, () => {
    const existing = ledger.db.prepare(`SELECT * FROM note WHERE commitment = ?`).get(commitment) as NoteRow | undefined;
    if (existing) {
      if (big(existing.value) !== value || existing.origin !== "deposit") {
        throw new ControlError("IDEMPOTENCY_CONFLICT", "note commitment is already registered with different details");
      }
      return { note: existing, created: false };
    }
    const ws = requireWorkspace(ledger);
    const note = registerApprovedNote(ledger, ws.id, commitment, value);
    writeAudit(ledger, {
      workspaceId: ws.id,
      scope: "notes",
      actorType: "service",
      actorId: "wallet",
      action: "note.register_deposit",
      policyResult: "not_applicable",
      details: { noteId: note.id },
    });
    return { note, created: true };
  });
}

export function confirmWalletChange(ledger: Ledger, purchaseId: string): NoteRow {
  return immediate(ledger.db, () => confirmChangeInserted(ledger, purchaseId));
}

/**
 * Owner public exit of an unreserved note. A reserved note cannot be exited through this path,
 * because a live purchase may still consume it.
 */
export function markWalletNoteExited(ledger: Ledger, commitment: string, observedAtMs: number): NoteRow {
  return immediate(ledger.db, () => {
    const note = ledger.db.prepare(`SELECT * FROM note WHERE commitment = ?`).get(commitment) as NoteRow | undefined;
    if (!note) throw new ControlError("NOT_FOUND", "note not found");
    if (note.state === "exited") return note;
    if (note.state !== "approved" && note.state !== "spendable_change" && note.state !== "pending_change") {
      throw new ControlError("RECOVERY_REQUIRED", `note in state ${note.state} cannot be recorded as exited`);
    }
    const from = note.state === "approved" ? "approved_unreserved" : note.state === "spendable_change" ? "confirmed_change" : "pending_change";
    ledger.db.prepare(`UPDATE note SET state = 'exited', updated_at_ms = ? WHERE id = ?`).run(ledger.now(), note.id);
    appendTokenEvent(ledger, {
      workspaceId: note.workspace_id,
      noteId: note.id,
      purchaseId: null,
      from,
      to: "external_recovered",
      amount: big(note.value),
      reason: "owner_public_exit",
      occurredAtMs: observedAtMs,
    });
    writeAudit(ledger, {
      workspaceId: note.workspace_id,
      scope: "notes",
      actorType: "service",
      actorId: "wallet",
      action: "note.public_exit",
      policyResult: "not_applicable",
      details: { noteId: note.id },
    });
    return ledger.db.prepare(`SELECT * FROM note WHERE id = ?`).get(note.id) as NoteRow;
  });
}

/**
 * The wallet proved the signed merchant payment can no longer land (its blockhash expired and no
 * transaction with that message exists). Only then may the funded wallet become recoverable.
 */
export function walletRecordMerchantExpired(ledger: Ledger, purchaseId: string): PurchaseRow {
  return immediate(ledger.db, () => {
    const p = getPurchaseRow(ledger, purchaseId);
    if (p.merchant_state === "expired_unsettled") return p;
    if (!["signed", "submitted", "uncertain"].includes(p.merchant_state)) {
      throw new ControlError("IDEMPOTENCY_CONFLICT", `merchant leg is ${p.merchant_state}`);
    }
    transition(ledger, p.id, "merchant", p.merchant_state, "expired_unsettled", "merchant_signature_expired");
    return getPurchaseRow(ledger, p.id);
  });
}

export function walletMarkRecoverable(ledger: Ledger, purchaseId: string, reason: string): PurchaseRow {
  return markRecoverable(ledger, purchaseId, reason);
}

export function walletRecordRecovery(
  ledger: Ledger,
  purchaseId: string,
  r: { recoveredPrincipal: bigint; tokenFeesPaid: bigint; sponsorLamportsSpent: bigint; observedAtMs: number },
): PurchaseRow {
  return recordExternalRecovery(ledger, purchaseId, r);
}

export interface LivePurchaseRef {
  id: string;
  authorization: string;
  funding: string;
  merchant: string;
  recovery: string;
  reservedNoteCommitment: string | null;
}

/** Purchases whose authority left control and that are not yet fully resolved. */
export function liveReleasedPurchases(ledger: Ledger): LivePurchaseRef[] {
  const rows = ledger.db
    .prepare(
      `SELECT p.*, n.commitment AS reserved_commitment FROM purchase p LEFT JOIN note n ON n.reserved_purchase_id = p.id
       WHERE p.payment_path = 'private_x402' AND p.funding_state NOT IN ('not_started', 'abandoned', 'not_required')
         AND NOT (p.funding_state = 'expired_unsettled')
         AND NOT (p.merchant_state = 'finalized' AND p.recovery_state = 'none')
         AND p.recovery_state <> 'recovered'
       ORDER BY p.created_at_ms`,
    )
    .all() as Array<PurchaseRow & { reserved_commitment: string | null }>;
  return rows.map((p) => ({
    id: p.id,
    authorization: p.authorization_state,
    funding: p.funding_state,
    merchant: p.merchant_state,
    recovery: p.recovery_state,
    reservedNoteCommitment: p.reserved_commitment,
  }));
}

export function noteRefs(ledger: Ledger): Array<{ commitment: string; value: string; state: string; origin: string; reservedPurchaseId: string | null; parentPurchaseId: string | null }> {
  const rows = ledger.db.prepare(`SELECT * FROM note ORDER BY created_at_ms`).all() as NoteRow[];
  return rows.map((n) => ({
    commitment: n.commitment,
    value: big(n.value).toString(),
    state: n.state,
    origin: n.origin,
    reservedPurchaseId: n.reserved_purchase_id,
    parentPurchaseId: n.parent_purchase_id,
  }));
}

export { getPurchaseRow };
