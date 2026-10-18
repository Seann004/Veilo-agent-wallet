import { randomUUID } from "node:crypto";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairFromPrivateKeyBytes,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  address,
  type Address,
  type Blockhash,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { DEMO_TOKEN_DECIMALS, type FundingBinding } from "@veilo/contracts";
import {
  associatedTokenAddress,
  exitPublicInstruction,
  exitWitness,
  nullifierHash,
  parseDecimal,
  spentNullifierPda,
  toBe32,
  toSolanaProof,
} from "@veilo/privacy-sdk";
import { hex64, hexToField, type WalletDeps } from "./deps";
import { WalletError } from "./errors";
import type { FundingService } from "./funding";
import { PRIVACY_WARNINGS, unsignedTransaction, verifiedPublicState } from "./pool";
import { PortUnavailableError } from "./ports";
import type { RecoveryRow } from "./store";

const EXITABLE = new Set(["indexed", "approved", "spendable"]);

/** Owner-only flows: public exit and fresh-wallet recovery. Both are publicly linkable. */
export class OwnerFlows {
  constructor(
    private readonly d: WalletDeps,
    private readonly funding: FundingService,
  ) {}

  private get now(): number {
    return (this.d.now ?? Date.now)();
  }

  /**
   * Builds an unsigned exit_public transaction. The owner's wallet must sign as the note's
   * original refund authority; the program pays only that key's ATA. Works for original and
   * change notes, and does not need approved-set membership.
   */
  async prepareExit(owner: Address, noteId: string): Promise<Record<string, unknown>> {
    const { store } = this.d;
    const note = store.note(noteId);
    if (!note) throw new WalletError("NOT_FOUND", "note not found");
    if (note.refundAuthority !== owner) throw new WalletError("POLICY_DENIED", "exit must be signed by the note's original refund authority");
    if (!EXITABLE.has(note.state)) throw new WalletError("NOTE_PENDING", `note in state ${note.state} cannot be exited`);
    if (note.value === 0n) throw new WalletError("POLICY_DENIED", "a zero-value note cannot be exited");
    if (note.salt === null) throw new WalletError("RECOVERY_REQUIRED", "note backup lacks its deposit salt");
    if (note.controlRegistered) {
      const ref = (await this.d.control.notes()).find((n) => n.commitment === note.commitment);
      if (ref?.state === "reserved") throw new WalletError("NOTE_PENDING", "note is reserved by a live purchase");
    }
    const ctx = await this.d.pool();
    const ps = await verifiedPublicState(this.d.poseidon, ctx, this.d.relayer, this.d.chain);
    const path = ps.statePath(hexToField(note.commitment));
    if (!path) throw new WalletError("NOTE_PENDING", "note is not in the finalized commitment tree");
    const w = exitWitness(this.d.poseidon, { note, statePath: path });
    const proved = await this.d.prover.prove("exit", w);
    const nf = nullifierHash(this.d.poseidon, note);
    const destination = (await associatedTokenAddress(owner, ctx.mint)).address;
    const spent = await spentNullifierPda(ctx.programId, ctx.poolState, toBe32(nf));
    const ownerSigner = createNoopSigner(owner);
    const ixs = [
      getSetComputeUnitLimitInstruction({ units: 300_000 }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: ownerSigner, ata: destination, owner, mint: ctx.mint }),
      exitPublicInstruction(
        ctx.programId,
        { refundAuthority: owner, payer: owner, poolState: ctx.poolState, vault: ctx.vault, vaultAuthority: ctx.vaultAuthority, destination, spentNullifier: spent.address },
        { proof: toSolanaProof(proved.proof), stateRoot: parseDecimal(proved.publicSignals[0]!), nullifierHash: nf, value: note.value, salt: note.salt },
      ),
    ];
    const bh = await this.d.chain.latestBlockhash();
    const transaction = unsignedTransaction(owner, bh, ixs);
    const exitId = randomUUID();
    store.tx(() => {
      store.insertExit({
        id: exitId,
        note_id: note.id,
        owner_pubkey: owner,
        nullifier_hash: hex64(nf),
        value: note.value,
        blockhash: bh.blockhash,
        last_valid_block_height: bh.lastValidBlockHeight,
        message_base64: transaction,
      });
      store.setNoteState(note.id, "exit_prepared");
      store.event("exit.prepared", exitId, { origin: note.origin });
    });
    return {
      exitId,
      transaction,
      lastValidBlockHeight: bh.lastValidBlockHeight.toString(),
      value: { amount: note.value.toString(), unit: "usdc_base_units" },
      destination,
      noteOrigin: note.origin,
      privacyWarning: PRIVACY_WARNINGS.exit,
    };
  }

  registerExit(owner: Address, exitId: string, signature: string): { exitId: string; state: string } {
    const ex = this.d.store.exit(exitId);
    if (!ex || ex.owner_pubkey !== owner) throw new WalletError("NOT_FOUND", "exit not found");
    if (ex.signature !== null && ex.signature !== signature) throw new WalletError("IDEMPOTENCY_CONFLICT", "a different signature is registered");
    if (ex.state === "prepared") this.d.store.updateExit(exitId, { state: "submitted", signature });
    return { exitId, state: this.d.store.exit(exitId)!.state };
  }

  private requireRecoveryAccount(): Address {
    if (this.d.ownerRecoveryAddress === null) throw new WalletError("NOT_READY", "OWNER_RECOVERY_ADDRESS is not configured; recovery has no permitted destination");
    return this.d.ownerRecoveryAddress;
  }

  /**
   * Plans recovery of a funded fresh wallet to the configured owner recovery account. It is
   * refused while the wallet's signed merchant payment could still settle.
   */
  async prepareRecovery(purchaseId: string): Promise<Record<string, unknown>> {
    const destinationOwner = this.requireRecoveryAccount();
    const { store } = this.d;
    const f = store.funding(purchaseId);
    if (!f) throw new WalletError("NOT_FOUND", "no funded wallet for this purchase");
    if (f.step !== "finalized") throw new WalletError("SETTLEMENT_UNCERTAIN", "funding withdrawal is not finalized; nothing is recoverable yet");
    const live = store.recoveries(["prepared", "submitted", "finalized"]).find((r) => r.purchase_id === purchaseId);
    if (live) return this.recoveryView(live);

    const merchant = await this.funding.merchantOutcome(purchaseId);
    if (merchant === "signed") {
      throw new WalletError("SETTLEMENT_UNCERTAIN", "the signed merchant payment may still settle; recovery waits until its blockhash expires or it settles");
    }
    let cp = await this.d.control.purchase(purchaseId);
    if ((merchant === "expired_unsettled" || merchant === "failed") && ["signed", "submitted", "uncertain"].includes(cp.states.merchant)) {
      cp = await this.d.control.merchantExpired(purchaseId);
    }
    if (merchant === "none" && cp.states.merchant === "signed" && (JSON.parse(f.binding_json) as FundingBinding).swap) {
      cp = await this.funding.recordSwapNotSigned(purchaseId);
    }
    if (cp.states.recovery === "none") cp = await this.d.control.markRecoverable(purchaseId, `merchant ${merchant === "none" ? "not signed" : merchant}`);
    if (cp.states.recovery !== "recoverable") throw new WalletError("RECOVERY_REQUIRED", `purchase recovery state is ${cp.states.recovery}`);

    const ctx = await this.d.pool();
    const freshAta = (await associatedTokenAddress(address(f.fresh_wallet), ctx.mint)).address;
    const amount = (await this.d.chain.tokenBalance(freshAta)) ?? 0n;
    const destinationAta = (await associatedTokenAddress(destinationOwner, ctx.mint)).address;
    const id = randomUUID();
    store.tx(() => {
      store.insertRecovery({
        id,
        purchase_id: purchaseId,
        fresh_wallet: f.fresh_wallet,
        destination_owner: destinationOwner,
        destination_ata: destinationAta,
        amount,
        rent_destination: ctx.sponsor,
      });
      store.event("recovery.prepared", id, { purchaseId, amount: amount.toString() });
    });
    return this.recoveryView(store.recovery(id)!);
  }

  recoveryView(r: RecoveryRow): Record<string, unknown> {
    return {
      recoveryId: r.id,
      purchaseId: r.purchase_id,
      state: r.state,
      amount: { amount: r.amount.toString(), unit: "usdc_base_units" },
      freshWallet: r.fresh_wallet,
      destinationOwner: r.destination_owner,
      destinationAta: r.destination_ata,
      rentDestination: r.rent_destination,
      signature: r.signature,
      privacyWarning: PRIVACY_WARNINGS.recovery,
    };
  }

  /**
   * Executes a prepared recovery: the fresh wallet signs a transfer of its whole balance to the
   * owner recovery ATA and closes its ATA with rent to the sponsor; the relayer adds the
   * sponsor's fee-payer signature. Blockhash and validity are stored before submission.
   */
  async confirmRecovery(recoveryId: string): Promise<Record<string, unknown>> {
    const { store, chain } = this.d;
    const r = store.recovery(recoveryId);
    if (!r) throw new WalletError("NOT_FOUND", "recovery not found");
    if (r.state !== "prepared") return this.reconcileRecovery(r);
    if (r.destination_owner !== this.requireRecoveryAccount()) throw new WalletError("POLICY_DENIED", "recovery destination differs from the configured owner recovery account");
    if ((await this.funding.merchantOutcome(r.purchase_id)) === "signed") {
      throw new WalletError("SETTLEMENT_UNCERTAIN", "the signed merchant payment may still settle");
    }
    const ctx = await this.d.pool();
    const freshAta = (await associatedTokenAddress(address(r.fresh_wallet), ctx.mint)).address;
    const balance = (await chain.tokenBalance(freshAta)) ?? 0n;
    if (balance !== r.amount) throw new WalletError("IDEMPOTENCY_CONFLICT", "fresh wallet balance changed; prepare recovery again");
    if (!(await chain.account(address(r.destination_ata)))) throw new WalletError("NOT_READY", "the owner recovery token account does not exist yet");

    const { seed } = store.freshWalletSeed(r.purchase_id);
    const kp = await createKeyPairFromPrivateKeyBytes(seed);
    const fresh = createNoopSigner(address(r.fresh_wallet));
    const ixs = [
      ...(r.amount > 0n
        ? [getTransferCheckedInstruction({ source: freshAta, mint: ctx.mint, destination: address(r.destination_ata), authority: fresh, amount: r.amount, decimals: DEMO_TOKEN_DECIMALS })]
        : []),
      getCloseAccountInstruction({ account: freshAta, destination: address(r.rent_destination), owner: fresh }),
    ];
    const bh = await chain.latestBlockhash();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(ctx.sponsor, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as Blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const tx = await partiallySignTransaction([kp], compileTransaction(msg));
    store.tx(() => {
      store.updateRecovery(r.id, { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight });
      store.event("recovery.signed", r.id, {});
    });
    const view = await this.d.relayer.submitRecovery({
      recoveryId: r.id,
      transaction: getBase64EncodedWireTransaction(tx),
      lastValidBlockHeight: bh.lastValidBlockHeight.toString(),
      freshWallet: address(r.fresh_wallet),
      destinationAta: address(r.destination_ata),
      amount: r.amount.toString(),
    });
    store.updateRecovery(r.id, { state: "submitted", signature: view.signature });
    return this.recoveryView(store.recovery(r.id)!);
  }

  /** Resolves a submitted recovery; finalized recovery and rent return are recorded as separate events. */
  async reconcileRecovery(r: RecoveryRow): Promise<Record<string, unknown>> {
    const { store, chain } = this.d;
    if (r.state === "submitted" && r.signature) {
      let view = null;
      try {
        view = await this.d.relayer.recovery(r.id);
      } catch (error) {
        if (!(error instanceof PortUnavailableError)) throw error;
      }
      const st = await chain.signatureStatus(r.signature);
      if (st?.confirmationStatus === "finalized" && st.err === null) {
        const f = store.funding(r.purchase_id)!;
        await this.d.control.recordRecovery(r.purchase_id, {
          recoveredPrincipal: r.amount,
          tokenFeesPaid: f.token_fee,
          sponsorLamportsSpent: view ? BigInt(view.sponsorFeeLamports) : 0n,
          observedAtMs: this.now,
        });
        store.tx(() => {
          store.updateRecovery(r.id, { state: "finalized" });
          store.event("recovery.principal_recovered", r.id, { amount: r.amount.toString() });
          store.event("recovery.rent_returned_to_sponsor", r.id, { lamports: view?.rentRecoveredLamports ?? "unknown" });
        });
      } else if (!st && r.last_valid_block_height !== null && (await chain.finalizedBlockHeight()) > r.last_valid_block_height) {
        store.updateRecovery(r.id, { state: "expired" });
      }
    }
    return this.recoveryView(store.recovery(r.id)!);
  }
}
