import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { address, createKeyPairFromPrivateKeyBytes, getBase58Decoder, getBase64EncodedWireTransaction, partiallySignTransaction, type SignatureBytes } from "@solana/kit";
import { payerBindingMessage } from "@veilo/contracts/marketplace";
import { isDeepStrictEqual } from "node:util";
import type {
  ExternalCallOutcome,
  ExternalCallSignRequest,
  FundingBinding,
  FundingResult,
  MerchantSignResult,
  PayerBindingResult,
  SwapResult,
  WithdrawalEvidence,
} from "@veilo/contracts";
import { DEVNET_SOL_USDC_WHIRLPOOL, WRAPPED_SOL_MINT } from "@veilo/contracts";
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
import { hex64, hexToField, KeyedMutex, type MerchantSigner, type WalletDeps } from "./deps";
import { describeError, isTransientRpcError } from "./diagnostics";
import { WalletError } from "./errors";
import { verifiedPublicState, type PoolContext, type VerifiedPublicState } from "./pool";
import { PortUnavailableError } from "./ports";
import type { ExternalCallRow, FundingRow, NoteRecord, SwapRow } from "./store";
import { buildSwapTransaction } from "./swap";

/** Relayer error codes that refuse a swap before co-signing it. */
const TERMINAL_SWAP_REFUSALS = new Set(["POLICY_DENIED", "INVALID_REQUEST", "BUDGET_EXCEEDED"]);

/** Wallet event recorded immediately before the fresh wallet signs its one swap. */
export const SWAP_SIGNATURE_PRODUCED = "swap.signature_produced";

/** Wallet event recorded immediately before the fresh wallet signs its one merchant payment. */
export const MERCHANT_SIGNATURE_PRODUCED = "merchant.signature_produced";

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
  /**
   * Signs payerBindingMessage(operationId, quoteDigest, payer) with the fresh payer key of an
   * unreleased attempt. The message is rebuilt here from the stored payer; no caller-supplied
   * bytes are ever signed, and nothing is signed once the attempt's proof has been released.
   */
  async signPayerBinding(purchaseId: string, body: { fundingRef: string; operationId: string; quoteDigest: string }): Promise<PayerBindingResult> {
    return this.mutex.run(purchaseId, async () => {
      const { store } = this.d;
      const f = store.funding(purchaseId);
      if (!f || body.fundingRef !== purchaseId) return { status: "refused", reason: "no funding for this purchase" };
      if (f.step !== "prepared") return { status: "refused", reason: "the funding proof was already released or discarded" };
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(body.operationId) || !/^[0-9a-f]{64}$/.test(body.quoteDigest)) {
        return { status: "refused", reason: "invalid operation or quote digest" };
      }
      const { address: payer, seed } = store.freshWalletSeed(purchaseId);
      if (payer !== f.fresh_wallet) return { status: "refused", reason: "fresh wallet does not match the funding attempt" };
      const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
      const message = payerBindingMessage(body.operationId, body.quoteDigest, payer);
      const proof = getBase58Decoder().decode(sign(null, Buffer.from(message, "utf8"), key));
      store.event("funding.payer_bound", purchaseId, { operationId: body.operationId, quoteDigest: body.quoteDigest });
      return { status: "signed", payer, proof };
    });
  }

  async signMerchant(purchaseId: string, body: { fundingRef: string; paymentRequired: unknown; binding: FundingBinding; exactAmountUsdc: bigint }): Promise<MerchantSignResult> {
    return this.mutex.run(`${purchaseId}:merchant`, async () => {
      const { store } = this.d;
      const prior = store.merchantPayment(purchaseId);
      if (prior) return { status: "signed", paymentSignatureHeader: prior.payment_header, payer: prior.fresh_wallet, messageHash: prior.message_hash };
      // A signature was produced earlier but its payment was never stored: it may exist outside
      // this process, so the fresh wallet never signs a second transfer.
      if (store.events(purchaseId).some((e) => e.kind === MERCHANT_SIGNATURE_PRODUCED)) {
        return { status: "recovery_required", reason: "a merchant signature was produced but its payment was not stored; reconcile before any new signature" };
      }
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
      if (body.binding.external !== undefined) return { status: "recovery_required", reason: "an external batch is paid per call, not as one merchant payment" };

      const { address: freshAddress, seed } = store.freshWalletSeed(purchaseId);
      const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
      let used = false;
      const wallet = {
        address: freshAddress,
        async signPaymentMessage({ messageBytes }: { messageBytes: Uint8Array }): Promise<SignatureBytes> {
          if (used || store.merchantPayment(purchaseId)) throw new WalletError("POLICY_DENIED", "fresh payment wallet already signed");
          used = true;
          // Recorded before signing, so a crash or failure after this point never re-signs.
          store.event(MERCHANT_SIGNATURE_PRODUCED, purchaseId, {});
          return new Uint8Array(sign(null, Buffer.from(messageBytes), key)) as SignatureBytes;
        },
      };
      let signed: Awaited<ReturnType<MerchantSigner["sign"]>>;
      try {
        signed = await this.d.merchant.sign({ paymentRequired: body.paymentRequired, binding: body.binding, exactAmount: f.payout, purchaseRef: purchaseId, wallet });
      } catch (error) {
        const detail = describeError(error);
        this.d.log?.(`[wallet] merchant signing for ${purchaseId} failed ${used ? "after" : "before"} signing: ${detail}`);
        if (used) {
          store.event("merchant.sign_failed_after_signature", purchaseId, { error: detail });
          return { status: "recovery_required", reason: `merchant signing failed after the fresh wallet signed (${detail}); reconcile before any new signature` };
        }
        if (isTransientRpcError(error)) {
          store.event("merchant.sign_deferred", purchaseId, { error: detail });
          return { status: "not_ready", reason: `merchant payment not signed yet; nothing was signed (${detail})` };
        }
        throw error;
      }
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
   * Signs one call of an external x402 batch with the batch's funded payer. Calls are signed in
   * index order, at most `maxCalls` times, each for exactly the approved unit price, and only
   * after every earlier call has a chain outcome. A repeated index returns the stored payment.
   */
  async signExternalCall(req: ExternalCallSignRequest): Promise<MerchantSignResult> {
    const { purchaseId } = req;
    return this.mutex.run(`${purchaseId}:merchant`, async () => {
      const { store } = this.d;
      const calls = store.externalCalls(purchaseId);
      const prior = calls.find((c) => Number(c.call_index) === req.callIndex);
      if (prior) return { status: "signed", paymentSignatureHeader: prior.payment_header, payer: prior.fresh_wallet, messageHash: prior.message_hash };
      const f = store.funding(purchaseId);
      if (!f || req.fundingRef !== purchaseId) return { status: "recovery_required", reason: "no funding for this purchase" };
      if (f.step !== "finalized") return { status: "not_ready", reason: "funding withdrawal is not finalized" };
      if (!isDeepStrictEqual(req.binding, JSON.parse(f.binding_json))) return { status: "recovery_required", reason: "service binding changed after funding" };
      const terms = req.binding.external;
      if (terms === undefined) return { status: "recovery_required", reason: "binding is not an external batch" };
      if (store.merchantPayment(purchaseId)) return { status: "recovery_required", reason: "this funding already paid a single merchant payment" };
      const unit = BigInt(terms.unitUsdc);
      if (unit <= 0n || unit * BigInt(terms.maxCalls) !== f.payout) return { status: "recovery_required", reason: "batch terms do not match the funded payout" };
      if (req.callIndex >= terms.maxCalls) return { status: "recovery_required", reason: "batch call limit reached" };
      if (req.callIndex !== calls.length) return { status: "recovery_required", reason: "external calls must be signed in order" };
      for (const c of calls) {
        const outcome = await this.#externalOutcome(c);
        if (outcome.status === "signed") return { status: "not_ready", reason: `call ${c.call_index} may still settle` };
      }
      const cp = await this.d.control.purchase(purchaseId);
      if (cp.states.funding !== "finalized" || cp.states.merchant !== "signed") {
        return { status: "not_ready", reason: `control has not authorized the batch (merchant ${cp.states.merchant})` };
      }

      const { address: freshAddress, seed } = store.freshWalletSeed(purchaseId);
      if (freshAddress !== f.fresh_wallet) return { status: "recovery_required", reason: "fresh wallet does not match the funding attempt" };
      const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
      let used = false;
      const wallet = {
        address: freshAddress,
        async signPaymentMessage({ messageBytes }: { messageBytes: Uint8Array }): Promise<SignatureBytes> {
          if (used) throw new WalletError("POLICY_DENIED", "external call already signed");
          used = true;
          return new Uint8Array(sign(null, Buffer.from(messageBytes), key)) as SignatureBytes;
        },
      };
      const signed = await this.d.merchant.sign({
        paymentRequired: req.paymentRequired,
        binding: req.binding,
        exactAmount: unit,
        purchaseRef: `${purchaseId}:${req.callIndex}`,
        wallet,
      });
      store.tx(() => {
        store.insertExternalCall({
          purchase_id: purchaseId,
          call_index: BigInt(req.callIndex),
          fresh_wallet: freshAddress,
          message_hash: signed.messageHash,
          payment_header: signed.paymentSignatureHeader,
          recent_blockhash: signed.recentBlockhash,
          amount: unit,
        });
        store.event("external_call.signed", purchaseId, { callIndex: req.callIndex, messageHash: signed.messageHash });
      });
      return { status: "signed", paymentSignatureHeader: signed.paymentSignatureHeader, payer: freshAddress, messageHash: signed.messageHash };
    });
  }

  async externalCallOutcome(purchaseId: string, callIndex: number): Promise<ExternalCallOutcome> {
    const c = this.d.store.externalCalls(purchaseId).find((r) => Number(r.call_index) === callIndex);
    return c ? this.#externalOutcome(c) : { status: "none" };
  }

  /** Outcome of a signed external call, found in the payer's history by the signed message. */
  async #externalOutcome(c: ExternalCallRow): Promise<ExternalCallOutcome> {
    const idx = Number(c.call_index);
    if (c.state === "finalized") return { status: "finalized", signature: c.settlement_signature as string };
    if (c.state === "expired_unsettled") return { status: "expired_unsettled" };
    if (c.state === "failed") return { status: "failed", signature: c.settlement_signature };
    const tx = await this.d.chain.findTransaction(address(c.fresh_wallet), c.message_hash);
    if (tx) {
      if (!tx.finalized) return { status: "signed" };
      if (tx.err !== null) {
        this.d.store.updateExternalCall(c.purchase_id, idx, "failed", tx.signature);
        return { status: "failed", signature: tx.signature };
      }
      this.d.store.updateExternalCall(c.purchase_id, idx, "finalized", tx.signature);
      return { status: "finalized", signature: tx.signature };
    }
    if (c.recent_blockhash === null || (await this.d.chain.isBlockhashValid(c.recent_blockhash))) return { status: "signed" };
    this.d.store.updateExternalCall(c.purchase_id, idx, "expired_unsettled", null);
    this.d.store.event("external_call.expired_unsettled", c.purchase_id, { callIndex: idx });
    return { status: "expired_unsettled" };
  }

  /**
   * Signs the funded fresh wallet's one devnet swap: all of its USDC into the pinned whirlpool
   * for at least the quoted minimum of SOL, unwrapped to the owner's configured address. Only
   * after control recorded sign_merchant for this purchase; a stored swap is resubmitted with
   * the same bytes and never signed again.
   */
  async signSwap(purchaseId: string, fundingRef: string, binding: FundingBinding): Promise<SwapResult> {
    return this.mutex.run(`${purchaseId}:merchant`, async () => {
      const { store, chain } = this.d;
      const prior = store.swap(purchaseId);
      if (prior) return this.#swapProgress(prior);
      if (store.events(purchaseId).some((e) => e.kind === SWAP_SIGNATURE_PRODUCED)) {
        return { status: "recovery_required", reason: "a swap signature was produced but not stored; reconcile before any new signature" };
      }
      const f = store.funding(purchaseId);
      if (!f || fundingRef !== purchaseId) return { status: "recovery_required", reason: "no funding for this purchase" };
      if (f.step !== "finalized") return { status: "not_ready", reason: "funding withdrawal is not finalized" };
      if (!isDeepStrictEqual(binding, JSON.parse(f.binding_json))) return { status: "recovery_required", reason: "service binding changed after funding" };
      const terms = binding.swap;
      const ctx = await this.d.pool();
      if (!terms || terms.whirlpool !== DEVNET_SOL_USDC_WHIRLPOOL || terms.outputMint !== WRAPPED_SOL_MINT || terms.inputMint !== ctx.mint) {
        return { status: "recovery_required", reason: "binding is not the pinned devnet USDC to SOL swap" };
      }
      if (store.merchantPayment(purchaseId) || store.externalCalls(purchaseId).length > 0) return { status: "recovery_required", reason: "this funding already paid a merchant" };
      const destination = this.d.ownerRecoveryAddress;
      if (!destination) return { status: "recovery_required", reason: "no owner address is configured to receive the swap output" };
      if (!this.d.swapQuoter) return { status: "not_ready", reason: "devnet swaps are not configured" };
      const cp = await this.d.control.purchase(purchaseId);
      if (cp.states.funding !== "finalized" || cp.states.merchant !== "signed") {
        return { status: "not_ready", reason: `control has not authorized the swap (merchant ${cp.states.merchant})` };
      }
      const freshUsdc = (await associatedTokenAddress(address(f.fresh_wallet), ctx.mint)).address;
      if ((await chain.tokenBalance(freshUsdc)) !== f.payout) return { status: "not_ready", reason: "the fresh wallet does not hold exactly the funded USDC" };

      const { address: freshAddress, seed } = store.freshWalletSeed(purchaseId);
      if (freshAddress !== f.fresh_wallet) return { status: "recovery_required", reason: "fresh wallet does not match the funding attempt" };
      let quote;
      try {
        quote = await this.d.swapQuoter.quote({ fresh: address(freshAddress), usdcMint: ctx.mint, inputAmount: f.payout, slippageBps: terms.slippageBps });
      } catch (error) {
        return { status: "not_ready", reason: `swap quote unavailable; nothing was signed (${describeError(error)})` };
      }
      if (quote.minOutLamports <= 0n) return { status: "not_ready", reason: "the pool quotes no SOL for this amount; nothing was signed" };
      const bh = await chain.latestBlockhash();
      const unsigned = await buildSwapTransaction({
        sponsor: ctx.sponsor,
        fresh: address(freshAddress),
        usdcMint: ctx.mint,
        swapIx: quote.swapIx,
        destination,
        blockhash: bh.blockhash,
        lastValidBlockHeight: bh.lastValidBlockHeight,
      });
      // Recorded before signing, so a crash after this point never signs a second swap.
      store.event(SWAP_SIGNATURE_PRODUCED, purchaseId, {});
      const signed = await partiallySignTransaction([await createKeyPairFromPrivateKeyBytes(seed)], unsigned);
      store.tx(() => {
        store.insertSwap({
          purchase_id: purchaseId,
          swap_id: randomUUID(),
          fresh_wallet: freshAddress,
          destination,
          input_amount: f.payout,
          min_out: quote.minOutLamports,
          est_out: quote.estOutLamports,
          transaction_b64: getBase64EncodedWireTransaction(signed),
          last_valid_block_height: bh.lastValidBlockHeight,
        });
        store.event("swap.signed", purchaseId, { minOut: quote.minOutLamports.toString(), estOut: quote.estOutLamports.toString() });
      });
      return this.#swapProgress(store.swap(purchaseId)!);
    });
  }

  async swapOutcome(purchaseId: string): Promise<SwapResult> {
    const s = this.d.store.swap(purchaseId);
    if (!s) return { status: "not_ready", reason: "no swap was signed for this purchase" };
    return this.#swapProgress(s);
  }

  /** Submits a stored swap if it was never acknowledged, then reports the relayer's chain outcome. */
  async #swapProgress(s: SwapRow): Promise<SwapResult> {
    const { store, relayer } = this.d;
    const amounts = { minOutLamports: s.min_out, estOutLamports: s.est_out, destination: s.destination };
    if (s.state === "finalized") return { status: "finalized", signature: s.signature!, sponsorLamports: s.sponsor_lamports, ...amounts };
    if (s.state === "failed" || s.state === "expired") {
      const reason = s.state === "expired" ? "the swap expired before landing" : s.signature === null ? "the relayer refused the swap; nothing was broadcast" : "the swap failed on-chain";
      return { status: "failed", signature: s.signature, reason };
    }
    let view;
    try {
      view = s.state === "signed"
        ? await relayer.submitSwap({ swapId: s.swap_id, transaction: s.transaction_b64, lastValidBlockHeight: s.last_valid_block_height.toString(), freshWallet: address(s.fresh_wallet), destination: address(s.destination) })
        : await relayer.swap(s.swap_id);
    } catch (error) {
      // The relayer refuses before co-signing, and only it can pay the fee, so these bytes can never land.
      if (s.state === "signed" && error instanceof ServiceCallError && TERMINAL_SWAP_REFUSALS.has(error.code)) {
        store.updateSwap(s.purchase_id, { state: "failed" });
        store.event("swap.refused", s.purchase_id, { code: error.code, message: error.message });
        return { status: "failed", signature: null, reason: `the relayer refused the swap (${error.code}: ${error.message}); nothing was broadcast` };
      }
      return { status: "not_ready", reason: `relayer unavailable (${describeError(error)}); the signed swap is kept and resubmitted unchanged` };
    }
    if (!view) return { status: "not_ready", reason: "the relayer has no record of this swap yet" };
    if (view.state === "submitted") {
      if (s.state === "signed") store.updateSwap(s.purchase_id, { state: "submitted", signature: view.signature });
      return { status: "submitted", signature: view.signature, ...amounts };
    }
    if (view.state === "finalized") {
      const sponsorLamports = BigInt(view.sponsorFeeLamports) + BigInt(view.sponsorRentLamports);
      store.updateSwap(s.purchase_id, { state: "finalized", signature: view.signature, sponsorLamports });
      store.event("swap.finalized", s.purchase_id, { signature: view.signature });
      return { status: "finalized", signature: view.signature, sponsorLamports, ...amounts };
    }
    store.updateSwap(s.purchase_id, { state: view.state, signature: view.signature });
    return { status: "failed", signature: view.signature, reason: view.error ?? `the swap ${view.state}` };
  }

  /**
   * Merchant-leg outcome from chain evidence: finalized when the signed message landed,
   * expired_unsettled only once its blockhash can no longer land and no such transaction exists.
   * For an external batch it is "signed" while any call may still settle.
   */
  async merchantOutcome(purchaseId: string): Promise<"none" | "signed" | "finalized" | "expired_unsettled" | "failed"> {
    const swap = this.d.store.swap(purchaseId);
    if (swap) {
      const r = await this.#swapProgress(swap);
      if (r.status === "finalized") return "finalized";
      if (r.status !== "failed") return "signed";
      // An expired swap never landed, so the fresh wallet still holds its USDC.
      return this.d.store.swap(purchaseId)!.state === "expired" ? "expired_unsettled" : "failed";
    }
    const calls = this.d.store.externalCalls(purchaseId);
    if (calls.length > 0) {
      const outcomes = await Promise.all(calls.map((c) => this.#externalOutcome(c)));
      if (outcomes.some((o) => o.status === "signed")) return "signed";
      return outcomes.some((o) => o.status === "finalized") ? "finalized" : "expired_unsettled";
    }
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
