import { commitment as noteCommitment, nullifierHash, parseDecimal } from "@veilo/privacy-sdk";
import { hex64, type WalletDeps } from "./deps";
import type { FundingService } from "./funding";
import type { NoteService } from "./notes";
import type { OwnerFlows } from "./owner-flows";
import { verifiedPublicState } from "./pool";

export const RESTORE_FLAG = "restore_pending";
/** Indices skipped after a restore; any key allocated after the backup lies inside this window. */
export const RESTORE_COUNTER_JUMP = 1000;

export interface RestoreScan {
  note: number;
  onetime: number;
  jump: number;
}

export interface ReconcileReport {
  fundings: Record<string, string>;
  merchant: Record<string, string>;
  notesSynced: boolean;
  recovered: { changeNotes: number; freshWallets: number };
  mismatches: string[];
  ready: boolean;
}

/**
 * Startup reconciliation, run before the service accepts new funding work. Every multi-leg
 * operation is advanced only from chain/relayer evidence; nothing is re-proved, re-signed or
 * re-funded to guess an outcome. Control/wallet disagreements raise a blocking flag.
 */
export async function reconcileOnStartup(d: WalletDeps, svc: { funding: FundingService; notes: NoteService; owner: OwnerFlows }): Promise<ReconcileReport> {
  const { store } = d;
  const report: ReconcileReport = { fundings: {}, merchant: {}, notesSynced: false, recovered: { changeNotes: 0, freshWallets: 0 }, mismatches: [], ready: false };

  const restore = store.flags().find((f) => f.name === RESTORE_FLAG);
  if (restore) {
    const scan = JSON.parse(restore.reason) as RestoreScan;
    const r = await recoverFromChainAfterRestore(d, scan);
    report.recovered = r.recovered;
    report.mismatches.push(...r.mismatches);
  }

  for (const f of store.fundings(["released", "submitted"])) {
    report.fundings[f.purchase_id] = (await svc.funding.reconcile(f)).status;
  }
  for (const f of store.fundings(["finalized"])) {
    report.merchant[f.purchase_id] = await svc.funding.merchantOutcome(f.purchase_id);
  }
  for (const r of store.recoveries(["submitted"])) await svc.owner.reconcileRecovery(r);
  report.notesSynced = (await svc.notes.sync()).synced;

  // Cross-check the authoritative ledger: every released purchase must be backed by wallet state.
  for (const p of await d.control.livePurchases()) {
    const f = store.funding(p.id);
    const released = ["proof_released", "submitted", "uncertain", "finalized"].includes(p.funding);
    if (released && (!f || f.step === "prepared" || f.step === "discarded")) {
      report.mismatches.push(`purchase ${p.id}: control shows released funding (${p.funding}) without matching wallet state`);
      store.setFlag(`recovery_required:${p.id}`, "control released funding that this wallet cannot account for");
    }
  }
  for (const n of await d.control.notes()) {
    if ((n.state === "approved" || n.state === "spendable_change" || n.state === "reserved") && !store.noteByCommitment(n.commitment)) {
      report.mismatches.push(`control note ${n.commitment.slice(0, 12)}… has no secrets in this wallet`);
      store.setFlag(`recovery_required:note:${n.commitment}`, "control tracks a spendable note this wallet cannot spend");
    }
  }
  if (restore && report.mismatches.length === 0 && report.notesSynced) store.clearFlag(RESTORE_FLAG);
  report.ready = store.flags().length === 0;
  store.event("reconcile.startup", null, { mismatches: report.mismatches.length, ready: report.ready });
  return report;
}

/**
 * After a restore, keys may have been allocated after the backup was taken. Their indices lie in
 * [backup counter, backup counter + jump): change notes and fresh wallets created in that window
 * are re-derived from the seed and matched against finalized spends, so change is not lost.
 */
export async function recoverFromChainAfterRestore(d: WalletDeps, scan: RestoreScan): Promise<{ recovered: { changeNotes: number; freshWallets: number }; mismatches: string[] }> {
  const { store, poseidon } = d;
  const out = { recovered: { changeNotes: 0, freshWallets: 0 }, mismatches: [] as string[] };
  let ps;
  try {
    ps = await verifiedPublicState(poseidon, await d.pool(), d.relayer, d.chain);
  } catch (error) {
    out.mismatches.push(`public state unavailable: ${(error as Error).message}`);
    return out;
  }
  const spends = new Map(ps.view.spends.map((s) => [parseDecimal(s.nullifierHash), s]));
  const knownFundingNullifiers = new Set(store.fundings().map((f) => f.nullifier_hash));
  const live = await d.control.livePurchases();
  for (const note of store.notes(["spendable", "reserved", "approved", "indexed"])) {
    const nf = nullifierHash(poseidon, note);
    const spend = spends.get(nf);
    if (!spend) continue;
    if (knownFundingNullifiers.has(hex64(nf))) {
      const f = store.fundings().find((x) => x.nullifier_hash === hex64(nf))!;
      if (f.step === "prepared") {
        out.mismatches.push(`purchase ${f.purchase_id}: proof was released after the backup and settled on-chain`);
        store.setFlag(`recovery_required:${f.purchase_id}`, "restored funding settled after the backup was taken");
      }
      continue;
    }
    // A spend this backup does not know about: recover its change note from the seed.
    const remainder = note.value - BigInt(spend.withdrawnValue);
    const target = parseDecimal(spend.newCommitment);
    let found = false;
    for (let i = scan.note; i < scan.note + scan.jump && remainder >= 0n; i++) {
      const s = store.noteSecretsAt(i);
      if (!s) continue;
      if (noteCommitment(poseidon, { value: remainder, label: note.label, ...s }) !== target) continue;
      store.tx(() => {
        store.insertNote({
          origin: "change",
          parentNoteId: note.id,
          keyIndex: i,
          commitment: hex64(target),
          value: remainder,
          label: note.label,
          ...s,
          salt: note.salt,
          refundAuthority: note.refundAuthority,
          state: "pending_change",
        });
        store.setNoteState(note.id, "spent", { reason: "spend found on-chain after restore" });
        store.event("restore.change_recovered", note.id, { keyIndex: i });
      });
      out.recovered.changeNotes += 1;
      found = true;
      break;
    }
    if (!found) out.mismatches.push(`note ${note.id}: spent on-chain but its change note was not re-derivable`);
    // Recover the fresh wallet that received this payout, if it came from this seed.
    const purchase = live.find((p) => p.reservedNoteCommitment === note.commitment);
    for (let j = scan.onetime; j < scan.onetime + scan.jump; j++) {
      if (store.oneTimeAddressAt(j) !== spend.destinationOwner) continue;
      if (purchase) {
        store.adoptFreshWallet(purchase.id, `restored:${purchase.id}`, j);
        out.recovered.freshWallets += 1;
      }
      store.setFlag(`recovery_required:${purchase?.id ?? spend.destinationOwner}`, "funded fresh wallet recovered from seed after restore; resolve through owner recovery");
      break;
    }
  }
  return out;
}
