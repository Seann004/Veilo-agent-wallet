import { randomUUID } from "node:crypto";
import { address, type Address } from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  addressBytes,
  associatedTokenAddress,
  depositCommitment,
  depositInstruction,
  deriveLabel,
  nullifierHash,
  parseDecimal,
  pendingDepositPda,
  precommitment,
  seenPrecommitmentPda,
  toBe32,
} from "@veilo/privacy-sdk";
import { ServiceCallError } from "./adapters";
import { hex64, hexToField, type WalletDeps } from "./deps";
import { WalletError } from "./errors";
import { PRIVACY_WARNINGS, unsignedTransaction, verifiedPublicState, type VerifiedPublicState } from "./pool";
import type { NoteRecord, NoteState } from "./store";

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export interface PreparedDeposit {
  depositId: string;
  transaction: string;
  lastValidBlockHeight: string;
  amount: string;
  privacyWarning: string;
}

/** Deposit preparation, note lifecycle tracking and the owner-facing status view. */
export class NoteService {
  constructor(private readonly d: WalletDeps) {}

  private get now(): number {
    return (this.d.now ?? Date.now)();
  }

  /**
   * Builds an unsigned deposit transaction for the owner's wallet to sign (the owner is the
   * refund authority and fee payer). Note secrets are derived and stored encrypted first.
   */
  async prepareDeposit(owner: Address, amount: bigint): Promise<PreparedDeposit> {
    const ctx = await this.d.pool();
    const ps = await verifiedPublicState(this.d.poseidon, ctx, this.d.relayer, this.d.chain);
    if (ps.pool.depositsPaused) throw new WalletError("POLICY_DENIED", "pool deposits are paused");
    if (amount < ps.pool.minDeposit || amount > ps.pool.maxDeposit) {
      throw new WalletError("POLICY_DENIED", `deposit must be between ${ps.pool.minDeposit} and ${ps.pool.maxDeposit} base units`);
    }
    const { store, poseidon } = this.d;
    let index: number;
    let secrets;
    let salt: Uint8Array;
    let label: bigint;
    for (;;) {
      index = store.allocate("note");
      secrets = store.noteSecretsAt(index);
      salt = store.saltAt(index);
      label = deriveLabel({ pool: addressBytes(ctx.poolState), mint: addressBytes(ctx.mint), refundAuthority: addressBytes(owner), salt }).label;
      if (secrets && secrets.noteSecret !== label) break;
    }
    const pre = precommitment(poseidon, secrets);
    const commitment = depositCommitment(poseidon, amount, label, pre);
    const pendingDeposit = await pendingDepositPda(ctx.programId, ctx.poolState, ps.pool.queueTail);
    const seen = await seenPrecommitmentPda(ctx.programId, ctx.poolState, toBe32(pre));
    const source = await associatedTokenAddress(owner, ctx.mint);
    const ixs = [
      getSetComputeUnitLimitInstruction({ units: 100_000 }),
      depositInstruction(
        ctx.programId,
        { depositor: owner, payer: owner, poolState: ctx.poolState, source: source.address, vault: ctx.vault, pendingDeposit: pendingDeposit.address, seenPrecommitment: seen.address },
        { amount, precommitment: pre, salt },
      ),
    ];
    const bh = await this.d.chain.latestBlockhash();
    const transaction = unsignedTransaction(owner, bh, ixs);
    const depositId = randomUUID();
    store.tx(() => {
      const noteId = store.insertNote({
        origin: "deposit",
        parentNoteId: null,
        keyIndex: index,
        commitment: hex64(commitment),
        value: amount,
        label,
        ...secrets,
        salt,
        refundAuthority: owner,
        state: "prepared",
      });
      store.insertDeposit({
        id: depositId,
        note_id: noteId,
        owner_pubkey: owner,
        amount,
        blockhash: bh.blockhash,
        last_valid_block_height: bh.lastValidBlockHeight,
        message_base64: transaction,
      });
      store.event("deposit.prepared", depositId, { amount: amount.toString() });
    });
    return { depositId, transaction, lastValidBlockHeight: bh.lastValidBlockHeight.toString(), amount: amount.toString(), privacyWarning: PRIVACY_WARNINGS.deposit };
  }

  registerDeposit(owner: Address, depositId: string, signature: string): { depositId: string; state: string } {
    const { store } = this.d;
    const dep = store.deposit(depositId);
    if (!dep || dep.owner_pubkey !== owner) throw new WalletError("NOT_FOUND", "deposit not found");
    if (!SIGNATURE.test(signature)) throw new WalletError("INVALID_REQUEST", "signature must be a base58 transaction signature");
    if (dep.signature !== null) {
      if (dep.signature !== signature) throw new WalletError("IDEMPOTENCY_CONFLICT", "a different signature is already registered for this deposit");
      return { depositId, state: dep.state };
    }
    if (dep.state !== "prepared") throw new WalletError("IDEMPOTENCY_CONFLICT", `deposit is ${dep.state}`);
    store.tx(() => {
      store.updateDeposit(depositId, { state: "submitted", signature });
      store.setNoteState(dep.note_id, "submitted");
      store.event("deposit.submitted", depositId, { signature });
    });
    return { depositId, state: "submitted" };
  }

  /**
   * Advances notes from chain evidence: deposit finalized → indexed (leaf inserted) →
   * approved (label in the current approved root) → spendable (witness rebuilt against the
   * finalized root and registered with control). Change notes follow the same insertion rule.
   */
  async sync(): Promise<{ synced: boolean; reason?: string }> {
    let ps: VerifiedPublicState;
    try {
      const ctx = await this.d.pool();
      ps = await verifiedPublicState(this.d.poseidon, ctx, this.d.relayer, this.d.chain);
    } catch (error) {
      return { synced: false, reason: (error as Error).message };
    }
    await this.syncDeposits(ps);
    await this.syncNotes(ps);
    await this.syncExits(ps);
    return { synced: true };
  }

  private async syncDeposits(ps: VerifiedPublicState): Promise<void> {
    const { store, chain } = this.d;
    const onchain = new Map(ps.view.deposits.map((d) => [hex64(parseDecimal(d.commitment)), d]));
    for (const dep of store.deposits(["prepared", "submitted"])) {
      const note = store.note(dep.note_id)!;
      const seen = onchain.get(note.commitment);
      if (seen) {
        store.tx(() => {
          store.updateDeposit(dep.id, { state: "finalized" });
          store.setNoteState(note.id, "finalized", { queueSeq: BigInt(seen.queueSeq) });
          store.event("deposit.finalized", dep.id, { queueSeq: seen.queueSeq });
        });
        continue;
      }
      if (dep.signature) {
        const st = await chain.signatureStatus(dep.signature);
        if (st && st.err !== null && st.confirmationStatus === "finalized") {
          store.tx(() => {
            store.updateDeposit(dep.id, { state: "failed" });
            store.setNoteState(note.id, "void", { reason: "deposit transaction failed" });
          });
          continue;
        }
        if (st) continue;
      }
      if ((await chain.finalizedBlockHeight()) > dep.last_valid_block_height) {
        // The blockhash can no longer land and no DepositQueued exists for this commitment.
        store.tx(() => {
          store.updateDeposit(dep.id, { state: "expired" });
          store.setNoteState(note.id, "void", { reason: "deposit transaction expired unsigned or unlanded" });
        });
      }
    }
  }

  private async syncNotes(ps: VerifiedPublicState): Promise<void> {
    const { store, control, poseidon } = this.d;
    const depositByCommitment = new Map(ps.view.deposits.map((d) => [hex64(parseDecimal(d.commitment)), d]));
    const exited = new Set(ps.view.exits.map((e) => parseDecimal(e.nullifierHash)));
    for (const note of store.notes(["finalized", "indexed", "approved", "spendable", "pending_change"])) {
      const c = hexToField(note.commitment);
      if (exited.has(nullifierHash(poseidon, note))) {
        store.setNoteState(note.id, "exited");
        continue;
      }
      if (note.origin === "deposit") {
        const dep = depositByCommitment.get(note.commitment);
        if (dep && (dep.state === "refunded" || dep.state === "skipped")) {
          store.setNoteState(note.id, "refunded");
          continue;
        }
      }
      const leaf = ps.leafIndexOf(c);
      if (leaf === null) continue;
      let state: NoteState = note.state;
      if (state === "finalized" || state === "pending_change") {
        store.setNoteState(note.id, "indexed", { leafIndex: leaf });
        state = "indexed";
      }
      if (note.value === 0n) continue;
      if (state === "indexed" && ps.isApproved(note.label)) {
        store.setNoteState(note.id, "approved");
        state = "approved";
      }
      if (state === "approved" && ps.statePath(c) !== null && ps.approvedPath(note.label) !== null) {
        try {
          if (note.origin === "deposit") await control.registerDepositNote(note.commitment, note.value);
          else await control.confirmChange(note.spendPurchaseId!);
        } catch (error) {
          // Control records the funding outcome on its own schedule; retry on the next sync.
          if (error instanceof ServiceCallError && error.code === "NOT_FOUND") continue;
          throw error;
        }
        store.setNoteState(note.id, "spendable", { controlRegistered: true });
        store.event("note.spendable", note.id, { origin: note.origin });
      }
    }
  }

  private async syncExits(ps: VerifiedPublicState): Promise<void> {
    const { store, chain, control } = this.d;
    const exited = new Set(ps.view.exits.map((e) => hex64(parseDecimal(e.nullifierHash))));
    for (const ex of store.exits(["prepared", "submitted"])) {
      const note = store.note(ex.note_id)!;
      if (exited.has(ex.nullifier_hash)) {
        if (note.controlRegistered) await control.noteExited(note.commitment, this.now);
        store.tx(() => {
          store.updateExit(ex.id, { state: "finalized" });
          store.setNoteState(note.id, "exited");
          store.event("exit.finalized", ex.id, {});
        });
        continue;
      }
      if (ex.signature) {
        const st = await chain.signatureStatus(ex.signature);
        if (st && !(st.confirmationStatus === "finalized" && st.err !== null)) continue;
      }
      if ((await chain.finalizedBlockHeight()) > ex.last_valid_block_height) {
        store.tx(() => {
          store.updateExit(ex.id, { state: "expired" });
          store.setNoteState(note.id, note.controlRegistered ? "spendable" : "indexed");
          store.event("exit.expired", ex.id, {});
        });
      }
    }
  }

  /** Owner view. Only spendable notes count as available; values are shown to the owner only. */
  status(): Record<string, unknown> {
    const { store } = this.d;
    const notes = store.notes();
    const deposits = new Map(store.deposits().map((d) => [d.note_id, d]));
    const sum = (states: NoteState[]) => notes.filter((n) => states.includes(n.state)).reduce((a, n) => a + n.value, 0n);
    return {
      notes: notes.map((n) => noteView(n, deposits.get(n.id)?.state ?? null, deposits.get(n.id)?.id ?? null)),
      totals: {
        spendable: { amount: sum(["spendable"]).toString(), unit: "usdc_base_units" },
        reserved: { amount: sum(["reserved"]).toString(), unit: "usdc_base_units" },
        pending: { amount: sum(["prepared", "submitted", "finalized", "indexed", "approved", "change_prepared", "pending_change"]).toString(), unit: "usdc_base_units" },
      },
      flags: store.flags(),
    };
  }
}

const DEPOSIT_STAGES = ["submitted", "finalized", "indexed", "approved", "spendable"] as const;

function noteView(n: NoteRecord, depositState: string | null, depositId: string | null): Record<string, unknown> {
  const reached = DEPOSIT_STAGES.indexOf(n.state as (typeof DEPOSIT_STAGES)[number]);
  return {
    id: n.id,
    origin: n.origin,
    depositId,
    state: n.state,
    value: { amount: n.value.toString(), unit: "usdc_base_units" },
    leafIndex: n.leafIndex,
    available: n.state === "spendable",
    ...(n.origin === "deposit"
      ? { depositStages: Object.fromEntries(DEPOSIT_STAGES.map((s, i) => [s, reached >= 0 ? i <= reached : n.state === "reserved" || n.state === "spent" || n.state === "exit_prepared" || n.state === "exited"])), depositTransaction: depositState }
      : {}),
    refundAuthority: n.refundAuthority === null ? null : address(n.refundAuthority),
  };
}
