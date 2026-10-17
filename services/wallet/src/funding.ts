import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { address, type SignatureBytes } from "@solana/kit";
import { isDeepStrictEqual } from "node:util";
import type { FundingBinding, FundingResult, MerchantSignResult, WithdrawalEvidence } from "@veilo/contracts";
import type { WithdrawalIntentWire } from "@veilo/contracts/relayer";
import {
  addressBytes,
  associatedTokenAddress,
  decodeSpentNullifier,
  intentContext,
  spendWitness,
  spentNullifierPda,
  toBe32,
  validateIntent,
  type GeneratedProof,
  type NoteSecrets,
  type WithdrawalIntent,
} from "@veilo/privacy-sdk";
import { ServiceCallError } from "./adapters";
import { hex64, hexToField, KeyedMutex, type WalletDeps } from "./deps";
import { WalletError } from "./errors";
import { verifiedPublicState, type PoolContext, type VerifiedPublicState } from "./pool";
import { PortUnavailableError } from "./ports";
import type { FundingRow, NoteRecord } from "./store";

export interface FundingInput {
  purchaseId: string;
  operationId: string;
  payoutUsdc: bigint;
  tokenFeeCapUsdc: bigint;
  sponsorLamportCap: bigint;
  inputNote: { commitment: string; value: bigint };
  binding: FundingBinding;
}

interface StoredProof {
  proof: GeneratedProof["proof"];
  publicSignals: string[];
}

const DEFAULT_RELEASE_MARGIN = 64n;
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function toSdkIntent(w: WithdrawalIntentWire): WithdrawalIntent {
  return {
    destinationTokenAccount: addressBytes(w.destinationTokenAccount),
    destinationOwner: addressBytes(w.destinationOwner),
    payoutAmount: BigInt(w.payoutAmount),
    relayerFee: BigInt(w.relayerFee),
    relayer: w.relayer === null ? null : addressBytes(w.relayer),
    relayerFeeTokenAccount: w.relayerFeeTokenAccount === null ? null : addressBytes(w.relayerFeeTokenAccount),
    validUntilSlot: BigInt(w.validUntilSlot),
  };
}

const failure = (status: "not_ready" | "recovery_required", reason: string): FundingResult => ({ status, reason });

/**
 * Private funding of one purchase's fresh payment wallet. Control records each authority stage
 * (prepare_proof, release_proof, sign_merchant) after rechecking policy and epochs; the wallet
 * re-reads that stage before acting and never releases proof or signature material otherwise.
 */
export class FundingService {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly d: WalletDeps) {}

  private get now(): number {
    return (this.d.now ?? Date.now)();
  }

  async prepare(req: FundingInput): Promise<FundingResult> {
    return this.mutex.run(req.purchaseId, async () => {
      const { store } = this.d;
      const existing = store.funding(req.purchaseId);
      if (existing?.step === "prepared") return { status: "prepared", fundingRef: existing.purchase_id, payer: existing.fresh_wallet };
      if (existing?.step === "discarded") return failure("not_ready", "this purchase's proof was discarded after its authority stopped");
      if (existing) return this.reconcile(existing);
      const flags = store.flags();
      if (flags.length > 0) return failure("recovery_required", `wallet needs reconciliation before new funding (${flags.map((f) => f.name).join(", ")})`);

      const cp = await this.d.control.purchase(req.purchaseId);
      if (cp.operationId !== req.operationId) return failure("recovery_required", "operation id differs from control's purchase");
      if (cp.states.authorization !== "reserved" || cp.states.funding !== "proof_prepared") {
        return failure("not_ready", `control has not recorded prepare_proof (authorization ${cp.states.authorization}, funding ${cp.states.funding})`);
      }
      if (BigInt(cp.price.amount) !== req.payoutUsdc) return failure("recovery_required", "payout differs from the authorized price");
      const note = store.noteByCommitment(req.inputNote.commitment);
      if (!note || note.state !== "spendable" || note.value !== req.inputNote.value) {
        return failure("not_ready", "the reserved note is not spendable in this wallet");
      }
      if (note.value < req.payoutUsdc) return failure("recovery_required", "reserved note is smaller than the payout");

      const ctx = await this.d.pool();
      // Persisted (with its counter) before any funding can reference the address.
      const fresh = store.reserveFreshWallet(req.purchaseId, req.operationId);
      const ps = await verifiedPublicState(this.d.poseidon, ctx, this.d.relayer, this.d.chain);
      const changeIndex = this.allocateChangeIndex(note);
      const change = store.noteSecretsAt(changeIndex)!;
      const destinationAta = (await associatedTokenAddress(fresh.address, ctx.mint)).address;
      const intent: WithdrawalIntentWire = {
        destinationTokenAccount: destinationAta,
        destinationOwner: fresh.address,
        payoutAmount: req.payoutUsdc.toString(),
        relayerFee: "0",
        relayer: ctx.relayer,
        relayerFeeTokenAccount: null,
        validUntilSlot: (ps.finalizedSlot + ctx.maxIntentSlots).toString(),
      };
      const built = await this.buildProof(ctx, ps, note, change, intent);
      store.tx(() => {
        const changeId = store.insertNote({
          origin: "change",
          parentNoteId: note.id,
          keyIndex: changeIndex,
          commitment: hex64(built.newCommitment),
          value: built.changeValue,
          label: note.label,
          ...change,
          salt: note.salt,
          refundAuthority: note.refundAuthority,
          state: "change_prepared",
          spendPurchaseId: req.purchaseId,
        });
        store.insertFunding({
          purchase_id: req.purchaseId,
          operation_id: req.operationId,
          input_note_id: note.id,
          change_note_id: changeId,
          fresh_wallet: fresh.address,
          payout: req.payoutUsdc,
          token_fee: 0n,
          sponsor_lamport_cap: req.sponsorLamportCap,
          nullifier_hash: hex64(built.nullifierHash),
          valid_until_slot: BigInt(intent.validUntilSlot),
          intent_json: JSON.stringify(intent),
          proof_json: JSON.stringify(built.proof),
          binding_json: JSON.stringify(req.binding),
        });
        store.setNoteState(note.id, "reserved", { spendPurchaseId: req.purchaseId });
        store.event("funding.prepared", req.purchaseId, { freshWallet: fresh.address, validUntilSlot: intent.validUntilSlot });
      });
      return { status: "prepared", fundingRef: req.purchaseId, payer: fresh.address };
    });
  }

  /**
   * Starts a new funding attempt after a prior attempt for the same note was proven
   * expired_unsettled: finalized slot past its bound and its nullifier unused, rechecked here
   * from chain evidence. The new attempt gets its own purchase reference, proof, slot bound,
   * change secrets and fresh wallet; the prior attempt's row and released proof stay as they
   * were and are never resent. The program's nullifier account still allows one spend only.
   */
  async reattemptAfterExpiry(priorPurchaseId: string, next: FundingInput): Promise<FundingResult> {
    const { store } = this.d;
    if (next.purchaseId === priorPurchaseId) return failure("recovery_required", "a new attempt needs its own purchase reference");
    if (store.funding(next.purchaseId)) return this.prepare(next);
    let prior = store.funding(priorPurchaseId);
    if (!prior) return failure("not_ready", "no prior funding attempt exists");
    if (next.operationId === prior.operation_id) return failure("recovery_required", "a new attempt needs its own operation reference");
    if (prior.step !== "expired_unsettled") {
      const r = await this.status(priorPurchaseId);
      if (r.status !== "expired_unsettled") return failure("not_ready", `prior attempt is ${r.status}; a new attempt waits until it is proven expired and unsettled`);
      prior = store.funding(priorPurchaseId)!;
    }
    const input = store.note(prior.input_note_id)!;
    if (input.commitment !== next.inputNote.commitment) return failure("recovery_required", "a new attempt must fund from the same input note as the prior attempt");
    // Slot first, then account: the account read is at least as recent as this slot.
    const ctx = await this.d.pool();
    const slot = await this.d.chain.finalizedSlot();
    const nf = await spentNullifierPda(ctx.programId, ctx.poolState, toBe32(hexToField(prior.nullifier_hash)));
    if (await this.d.chain.account(nf.address)) return failure("recovery_required", "the input note's nullifier is spent; no new attempt is possible");
    if (slot <= prior.valid_until_slot) return failure("not_ready", "the prior attempt's slot bound has not passed at finalized commitment");
    store.event("funding.reattempt", next.purchaseId, {
      priorPurchaseId,
      priorOperationId: prior.operation_id,
      operationId: next.operationId,
      priorValidUntilSlot: prior.valid_until_slot.toString(),
      observedFinalizedSlot: slot.toString(),
    });
    return this.prepare(next);
  }

  private allocateChangeIndex(parent: NoteRecord): number {
    for (;;) {
      const i = this.d.store.allocate("note");
      const s = this.d.store.noteSecretsAt(i);
      if (s && s.nullifierSecret !== parent.nullifierSecret && s.noteSecret !== parent.label) return i;
    }
  }

  private async buildProof(ctx: PoolContext, ps: VerifiedPublicState, note: NoteRecord, change: NoteSecrets, intentWire: WithdrawalIntentWire) {
    const statePath = ps.statePath(hexToField(note.commitment));
    if (!statePath) throw new WalletError("NOTE_PENDING", "note is not in the finalized commitment tree");
    const approvedPath = ps.approvedPath(note.label);
    if (!approvedPath) throw new WalletError("NOTE_PENDING", "note label is not in the current approved set");
    const intent = toSdkIntent(intentWire);
    validateIntent(intent, ps.pool.maxRelayerFee, ps.finalizedSlot);
    const derivation = intentContext(
      { programId: addressBytes(ctx.programId), pool: addressBytes(ctx.poolState), genesisHash: ctx.genesisHash, mint: addressBytes(ctx.mint) },
      intent,
    );
    const w = spendWitness(this.d.poseidon, {
      note,
      statePath,
      approvedPath,
      context: derivation.context,
      withdrawnValue: derivation.withdrawnValue,
      change,
    });
    const proved = await this.d.prover.prove("spend", w);
    const proof: StoredProof = { proof: proved.proof, publicSignals: proved.publicSignals };
    return { proof, nullifierHash: w.nullifierHash, newCommitment: w.newCommitment, changeValue: w.changeNote.value };
  }

  /** Rebuilds an unreleased proof whose slot bound is too close; nothing has left the wallet yet. */
  private async refreshUnreleased(f: FundingRow): Promise<FundingRow> {
    const ctx = await this.d.pool();
    const ps = await verifiedPublicState(this.d.poseidon, ctx, this.d.relayer, this.d.chain);
    const note = this.d.store.note(f.input_note_id)!;
    const changeNote = this.d.store.note(f.change_note_id)!;
    const intent = { ...(JSON.parse(f.intent_json) as WithdrawalIntentWire), validUntilSlot: (ps.finalizedSlot + ctx.maxIntentSlots).toString() };
    const built = await this.buildProof(ctx, ps, note, changeNote, intent);
    if (hex64(built.newCommitment) !== changeNote.commitment) throw new WalletError("RECOVERY_REQUIRED", "rebuilt change commitment differs");
    this.d.store.db
      .prepare(`UPDATE funding SET valid_until_slot = ?, intent_json = ?, proof_json = ?, updated_at_ms = ? WHERE purchase_id = ? AND step = 'prepared'`)
      .run(BigInt(intent.validUntilSlot), JSON.stringify(intent), JSON.stringify(built.proof), this.now, f.purchase_id);
    this.d.store.event("funding.proof_refreshed", f.purchase_id, { validUntilSlot: intent.validUntilSlot });
    return this.d.store.funding(f.purchase_id)!;
  }

  private discard(f: FundingRow, reason: string): void {
    const { store } = this.d;
    store.tx(() => {
      store.updateFunding(f.purchase_id, { step: "discarded" });
      store.setNoteState(f.change_note_id, "void", { reason });
      store.setNoteState(f.input_note_id, "spendable", { spendPurchaseId: null });
      store.event("funding.discarded", f.purchase_id, { reason });
    });
  }

  async release(purchaseId: string, fundingRef: string): Promise<FundingResult> {
    return this.mutex.run(purchaseId, async () => {
      let f = this.d.store.funding(purchaseId);
      if (!f) return failure("recovery_required", "no prepared proof exists for this purchase");
      if (fundingRef !== f.purchase_id) return failure("recovery_required", "funding reference mismatch");
      if (f.step === "discarded") return failure("not_ready", "proof was discarded after authority stopped");
      if (f.step !== "prepared") return this.reconcile(f);

      const flags = this.d.store.flags();
      if (flags.length > 0) return failure("not_ready", `wallet needs reconciliation before releasing a proof (${flags.map((x) => x.name).join(", ")})`);
      // Authority boundary: control must have recorded release_proof after its recheck.
      const cp = await this.d.control.purchase(purchaseId);
      const released = cp.states.authorization === "released" && (cp.states.funding === "proof_released" || cp.states.funding === "submitted");
      if (!released) {
        if (cp.states.authorization === "rejected" || cp.states.funding === "abandoned") {
          this.discard(f, "authority stopped before release");
          return failure("not_ready", "authority stopped before the proof was released; the proof was discarded and nothing left the wallet");
        }
        return failure("not_ready", `control has not recorded release_proof (authorization ${cp.states.authorization}, funding ${cp.states.funding})`);
      }
      const margin = this.d.releaseMarginSlots ?? DEFAULT_RELEASE_MARGIN;
      const slot = await this.d.chain.finalizedSlot();
      if (f.valid_until_slot < slot + margin) f = await this.refreshUnreleased(f);

      // Recorded as live exposure before the proof leaves this process.
      const withdrawalId = randomUUID();
      this.d.store.tx(() => {
        this.d.store.updateFunding(purchaseId, { step: "released", released_at_ms: BigInt(this.now), relayer_withdrawal_id: withdrawalId });
        this.d.store.event("proof.released", purchaseId, { validUntilSlot: f.valid_until_slot.toString(), withdrawalId });
      });
      return this.submit(this.d.store.funding(purchaseId)!);
    });
  }

  private withdrawalRequest(f: FundingRow) {
    const stored = JSON.parse(f.proof_json) as StoredProof;
    return {
      withdrawalId: f.relayer_withdrawal_id!,
      proof: stored.proof as never,
      publicSignals: stored.publicSignals,
      intent: JSON.parse(f.intent_json) as WithdrawalIntentWire,
      sponsorLamportCap: f.sponsor_lamport_cap.toString(),
    };
  }

  private async submit(f: FundingRow): Promise<FundingResult> {
    try {
      const view = await this.d.relayer.submitWithdrawal(this.withdrawalRequest(f));
      this.d.store.tx(() => {
        if (f.step === "released") this.d.store.updateFunding(f.purchase_id, { step: "submitted", ...(view.signature ? { signature: view.signature } : {}) });
        else if (view.signature && !f.signature) this.d.store.updateFunding(f.purchase_id, { signature: view.signature });
        this.d.store.event("withdrawal.submitted", f.purchase_id, { state: view.state });
      });
      if (view.state === "rejected" || view.state === "failed") {
        return { status: "uncertain", fundingRef: f.purchase_id, reason: `relayer reported ${view.state}; the released proof stays live exposure until its slot bound passes` };
      }
      return { status: "submitted", fundingRef: f.purchase_id, signature: view.signature };
    } catch (error) {
      if (error instanceof PortUnavailableError || error instanceof ServiceCallError) {
        this.d.store.event("withdrawal.submit_unconfirmed", f.purchase_id, { error: error.message });
        return { status: "uncertain", fundingRef: f.purchase_id, reason: "relayer reply was not received; the same withdrawal will be reconciled, never re-proved" };
      }
      throw error;
    }
  }

  async status(purchaseId: string): Promise<FundingResult> {
    return this.mutex.run(purchaseId, async () => {
      const f = this.d.store.funding(purchaseId);
      if (!f) return failure("not_ready", "no funding exists for this purchase");
      return this.reconcile(f);
    });
  }

  /**
   * Resolves a funding from chain evidence. A released proof is settled only by a finalized
   * spend of its nullifier, and is expired only when a finalized slot past its bound shows the
   * nullifier unused; anything else stays submitted/uncertain.
   */
  async reconcile(f: FundingRow): Promise<FundingResult> {
    const ref = f.purchase_id;
    switch (f.step) {
      case "prepared":
        return { status: "prepared", fundingRef: ref, payer: f.fresh_wallet };
      case "discarded":
        return failure("not_ready", "proof was discarded after authority stopped");
      case "finalized":
        return { status: "finalized", fundingRef: ref, evidence: parseEvidence(f.evidence_json!) };
      case "expired_unsettled":
        return { status: "expired_unsettled", fundingRef: ref, reason: "slot bound passed with the nullifier unused" };
      default:
        break;
    }
    const ctx = await this.d.pool();
    const nf = hexToField(f.nullifier_hash);
    let view = null;
    let relayerDown = false;
    try {
      view = await this.d.relayer.withdrawal(f.relayer_withdrawal_id!);
    } catch (error) {
      if (!(error instanceof PortUnavailableError || error instanceof ServiceCallError)) throw error;
      relayerDown = true;
    }
    // Slot first, then account: the account read is at least as recent as this slot.
    const slot = await this.d.chain.finalizedSlot();
    const pda = await spentNullifierPda(ctx.programId, ctx.poolState, toBe32(nf));
    const acct = await this.d.chain.account(pda.address);
    if (acct) {
      const spent = decodeSpentNullifier(acct.data);
      if (spent.kind === "exit") return this.markExpired(f, "the input note was exited publicly; this spend can no longer settle");
      const sig = view?.signature ?? f.signature;
      if (!sig) return { status: "uncertain", fundingRef: ref, reason: "nullifier is spent but the withdrawal signature is unknown" };
      const st = await this.d.chain.signatureStatus(sig);
      if (st?.confirmationStatus !== "finalized" || st.err !== null) {
        return { status: "uncertain", fundingRef: ref, reason: "nullifier is spent; waiting for the withdrawal signature to finalize" };
      }
      return this.markFinalized(f, sig, view ? BigInt(view.sponsorFeeLamports) + BigInt(view.sponsorRentLamports) : 0n);
    }
    if (slot > f.valid_until_slot) return this.markExpired(f, "finalized slot is past the intent bound and the nullifier is unused");
    if (relayerDown) return { status: "uncertain", fundingRef: ref, reason: "relayer unreachable; withdrawal outcome pending" };
    if (view === null || (view.state === "rejected" && view.signature === null && view.ataSignature === null)) {
      // The relayer never recorded the request, or rejected it before sending anything (for
      // example a root not yet visible): resend the same material while the bound allows it.
      return this.submit(f);
    }
    return { status: "submitted", fundingRef: ref, signature: view.signature };
  }

  private markFinalized(f: FundingRow, signature: string, sponsorLamports: bigint): FundingResult {
    const { store } = this.d;
    const change = store.note(f.change_note_id)!;
    const evidence: WithdrawalEvidence = {
      payout: f.payout,
      tokenFees: f.token_fee,
      change: change.value,
      changeCommitment: change.value > 0n ? change.commitment : null,
      observedAtMs: this.now,
      signature,
      sponsorLamportsSpent: sponsorLamports,
    };
    store.tx(() => {
      if (f.step === "released") store.updateFunding(f.purchase_id, { step: "submitted" });
      store.updateFunding(f.purchase_id, { step: "finalized", signature, evidence_json: JSON.stringify(serializeEvidence(evidence)) });
      store.setNoteState(f.input_note_id, "spent");
      store.setNoteState(f.change_note_id, "pending_change");
      store.event("funding.finalized", f.purchase_id, { signature });
    });
    return { status: "finalized", fundingRef: f.purchase_id, evidence };
  }

  private markExpired(f: FundingRow, reason: string): FundingResult {
    const { store } = this.d;
    store.tx(() => {
      store.updateFunding(f.purchase_id, { step: "expired_unsettled" });
      store.setNoteState(f.change_note_id, "void", { reason });
      const input = store.note(f.input_note_id)!;
      if (input.state === "reserved") store.setNoteState(f.input_note_id, "spendable", { spendPurchaseId: null });
      store.event("funding.expired_unsettled", f.purchase_id, { reason });
    });
    return { status: "expired_unsettled", fundingRef: f.purchase_id, reason };
  }

  /**
   * Signs the purchase's single x402 payment. The signed header is stored before it is
   * returned; a repeated call returns the stored payment and never signs another transfer.
   */
  async signMerchant(purchaseId: string, body: { fundingRef: string; paymentRequired: unknown; binding: FundingBinding; exactAmountUsdc: bigint }): Promise<MerchantSignResult> {
    return this.mutex.run(`${purchaseId}:merchant`, async () => {
      const { store } = this.d;
      const prior = store.merchantPayment(purchaseId);
      if (prior) return { status: "signed", paymentSignatureHeader: prior.payment_header, payer: prior.fresh_wallet, messageHash: prior.message_hash };
      const f = store.funding(purchaseId);
      if (!f || body.fundingRef !== purchaseId) return { status: "recovery_required", reason: "no funding for this purchase" };
      if (f.step !== "finalized") return { status: "not_ready", reason: "funding withdrawal is not finalized" };
      const cp = await this.d.control.purchase(purchaseId);
      if (cp.states.funding !== "finalized" || cp.states.merchant !== "signed") {
        if (["abandoned", "expired_unsettled"].includes(cp.states.merchant)) {
          return { status: "recovery_required", reason: "merchant leg was stopped; the funded wallet is recoverable by the owner" };
        }
        return { status: "not_ready", reason: `control has not recorded sign_merchant (merchant ${cp.states.merchant})` };
      }
      if (body.exactAmountUsdc !== f.payout) return { status: "recovery_required", reason: "merchant amount differs from the funded payout" };
      if (!isDeepStrictEqual(body.binding, JSON.parse(f.binding_json))) return { status: "recovery_required", reason: "service binding changed after funding" };

      const { address: freshAddress, seed } = store.freshWalletSeed(purchaseId);
      const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
      let used = false;
      const wallet = {
        address: freshAddress,
        async signPaymentMessage({ messageBytes }: { messageBytes: Uint8Array }): Promise<SignatureBytes> {
          if (used || store.merchantPayment(purchaseId)) throw new WalletError("POLICY_DENIED", "fresh payment wallet already signed");
          used = true;
          return new Uint8Array(sign(null, Buffer.from(messageBytes), key)) as SignatureBytes;
        },
      };
      const signed = await this.d.merchant.sign({ paymentRequired: body.paymentRequired, binding: body.binding, exactAmount: f.payout, purchaseRef: purchaseId, wallet });
      store.tx(() => {
        store.insertMerchantPayment({
          purchase_id: purchaseId,
          fresh_wallet: freshAddress,
          message_hash: signed.messageHash,
          payment_header: signed.paymentSignatureHeader,
          recent_blockhash: signed.recentBlockhash,
          amount: f.payout,
        });
        store.event("merchant.signed", purchaseId, { messageHash: signed.messageHash });
      });
      return { status: "signed", paymentSignatureHeader: signed.paymentSignatureHeader, payer: freshAddress, messageHash: signed.messageHash };
    });
  }

  /**
   * Merchant-leg outcome from chain evidence: finalized when the signed message landed,
   * expired_unsettled only once its blockhash can no longer land and no such transaction exists.
   */
  async merchantOutcome(purchaseId: string): Promise<"none" | "signed" | "finalized" | "expired_unsettled" | "failed"> {
    const m = this.d.store.merchantPayment(purchaseId);
    if (!m) return "none";
    if (m.state !== "signed") return m.state;
    if (m.recent_blockhash === null) return "signed";
    const stillValid = await this.d.chain.isBlockhashValid(m.recent_blockhash);
    const tx = await this.d.chain.findTransaction(address(m.fresh_wallet), m.message_hash);
    if (tx) {
      if (!tx.finalized) return "signed";
      if (tx.err !== null) {
        this.d.store.updateMerchantPayment(purchaseId, "expired_unsettled", tx.signature);
        return "failed";
      }
      this.d.store.updateMerchantPayment(purchaseId, "finalized", tx.signature);
      return "finalized";
    }
    if (stillValid) return "signed";
    this.d.store.updateMerchantPayment(purchaseId, "expired_unsettled", null);
    this.d.store.event("merchant.expired_unsettled", purchaseId, {});
    return "expired_unsettled";
  }
}

function serializeEvidence(e: WithdrawalEvidence): Record<string, unknown> {
  return {
    payout: e.payout.toString(),
    tokenFees: e.tokenFees.toString(),
    change: e.change.toString(),
    changeCommitment: e.changeCommitment,
    observedAtMs: e.observedAtMs,
    signature: e.signature,
    sponsorLamportsSpent: e.sponsorLamportsSpent.toString(),
  };
}

function parseEvidence(json: string): WithdrawalEvidence {
  const e = JSON.parse(json) as Record<string, string | number | null>;
  return {
    payout: BigInt(e.payout as string),
    tokenFees: BigInt(e.tokenFees as string),
    change: BigInt(e.change as string),
    changeCommitment: e.changeCommitment as string | null,
    observedAtMs: e.observedAtMs as number,
    signature: e.signature as string,
    sponsorLamportsSpent: BigInt(e.sponsorLamportsSpent as string),
  };
}
