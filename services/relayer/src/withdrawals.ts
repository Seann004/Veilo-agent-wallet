import { createPublicKey, verify as edVerify } from "node:crypto";
import { address, createNoopSigner, getAddressEncoder, getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { API_ERROR_STATUS, type ApiErrorCode } from "@veilo/contracts";
import type { RecoveryRequestWire, RecoveryViewWire, WithdrawalRequestWire, WithdrawalViewWire } from "@veilo/contracts/relayer";
import {
  addressBytes,
  associatedTokenAddress,
  decodeApprovalState,
  decodePoolState,
  hexToBytes,
  intentContext,
  IntentError,
  knownRoots,
  parseDecimal,
  pendingChangePda,
  spendPrivateInstruction,
  spentNullifierPda,
  toBe32,
  toSolanaProof,
  TOKEN_PROGRAM_ID,
  validateIntent,
  verifyProof,
  type DeploymentManifest,
  type WithdrawalIntent,
} from "@veilo/privacy-sdk";
import { decodeWireTransaction } from "@veilo/x402-client";
import type { Groth16Proof, VerificationKey } from "snarkjs";
import type { RelayerChain } from "./chain";
import { recordSponsorEvent, sponsorTotals, type RelayerDb } from "./db";
import { sponsorCosign, sponsorSignedTx, type SponsorKey } from "./sponsor";

export class RelayerError extends Error {
  override readonly name = "RelayerError";
  readonly status: number;
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.status = API_ERROR_STATUS[code];
  }
}

/** Base fee per signature; the relayer sets no priority fee. */
export const LAMPORTS_PER_SIGNATURE = 5_000n;
export const TOKEN_ACCOUNT_SIZE = 165;

export interface RelayerContext {
  db: RelayerDb;
  chain: RelayerChain;
  sponsor: SponsorKey | null;
  /** Verified deployment manifest, or null while missing/mismatched (fails closed). */
  manifest: () => DeploymentManifest | null;
  spendVk: VerificationKey;
  sponsorCapLamports: bigint;
  now?: () => number;
}

interface WithdrawalRow {
  id: string;
  nullifier_hash: string;
  request_json: string;
  destination_owner: string;
  destination_ata: string;
  valid_until_slot: bigint;
  sponsor_cap: bigint;
  state: WithdrawalViewWire["state"];
  ata_signature: string | null;
  ata_blockhash: string | null;
  ata_last_valid_block_height: bigint | null;
  signature: string | null;
  blockhash: string | null;
  last_valid_block_height: bigint | null;
  attempts: bigint;
  finalized_slot: bigint | null;
  error: string | null;
  checked_at_ms: bigint | null;
}

function toIntent(w: WithdrawalRequestWire["intent"]): WithdrawalIntent {
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

const canonicalJson = (v: unknown) => JSON.stringify(v);

/**
 * Accepts withdrawal requests that carry only public proof material, checks them fully
 * off-chain (intent context, roots, nullifier, Groth16 proof, sponsor cap) and submits them
 * with the sponsor as fee payer. The fresh wallet's ATA is created by a separate sponsor
 * transaction before the spend.
 */
export class WithdrawalService {
  constructor(private readonly c: RelayerContext) {}

  private get now(): number {
    return (this.c.now ?? Date.now)();
  }

  private ready(): { manifest: DeploymentManifest; sponsor: SponsorKey } {
    const manifest = this.c.manifest();
    if (!manifest) throw new RelayerError("NOT_READY", "deployment is not verified; withdrawals are stopped");
    if (!this.c.sponsor) throw new RelayerError("NOT_READY", "SPONSOR_KEY_PATH is not configured");
    if (this.c.sponsor.address !== manifest.authorities.sponsor || this.c.sponsor.address !== manifest.authorities.relayer) {
      throw new RelayerError("NOT_READY", "sponsor key does not match the manifest sponsor/relayer authority");
    }
    return { manifest, sponsor: this.c.sponsor };
  }

  row(id: string): WithdrawalRow | undefined {
    return this.c.db.prepare(`SELECT * FROM withdrawal WHERE id = ?`).get(id) as WithdrawalRow | undefined;
  }

  view(id: string): WithdrawalViewWire | null {
    const r = this.row(id);
    if (!r) return null;
    const lamports = (kind: string) =>
      this.c.db
        .prepare(`SELECT ifnull(sum(lamports), 0) FROM sponsor_event WHERE ref = ? AND kind = ?`)
        .pluck()
        .get(`withdrawal:${id}`, kind) as bigint;
    return {
      withdrawalId: r.id,
      state: r.state,
      nullifierHash: BigInt(`0x${r.nullifier_hash}`).toString(),
      validUntilSlot: r.valid_until_slot.toString(),
      ataSignature: r.ata_signature,
      signature: r.signature,
      blockhash: r.blockhash,
      lastValidBlockHeight: r.last_valid_block_height === null ? null : r.last_valid_block_height.toString(),
      sponsorFeeLamports: lamports("fee_spent").toString(),
      sponsorRentLamports: lamports("rent_outstanding").toString(),
      finalizedSlot: r.finalized_slot === null ? null : r.finalized_slot.toString(),
      error: r.error,
    };
  }

  /**
   * Records the request before any chain read: local checks (identity, fees, intent context,
   * Groth16 proof) run first, then the row is inserted, then chain checks run. A chain read that
   * fails leaves the row recorded and unchecked; `advance` repeats the checks before sending.
   * A request rejected before anything was sent is checked again when resubmitted unchanged.
   */
  async submit(req: WithdrawalRequestWire): Promise<WithdrawalViewWire> {
    const existing = this.row(req.withdrawalId);
    if (existing) {
      if (existing.request_json !== canonicalJson(req)) throw new RelayerError("IDEMPOTENCY_CONFLICT", "withdrawal id was used with different material");
      if (existing.state === "rejected" && this.attemptCount(existing.id) === 0n) {
        try {
          this.set(existing.id, { state: "accepted", checked_at_ms: null, error: null });
        } catch (error) {
          if (String((error as Error).message).includes("UNIQUE")) throw new RelayerError("IDEMPOTENCY_CONFLICT", "another live withdrawal exists for this nullifier");
          throw error;
        }
      }
      if (this.row(existing.id)!.state === "accepted") await this.advanceOrReport(existing.id);
      return this.view(req.withdrawalId)!;
    }
    const { manifest, sponsor } = this.ready();
    const mint = address(manifest.token.mint);
    const program = address(manifest.program.programId);
    const poolState = address(manifest.pool.poolState);
    const ps = req.publicSignals.map(parseDecimal);
    const [context, , , nullifierHash, withdrawn, newCommitment] = ps as [bigint, bigint, bigint, bigint, bigint, bigint];
    if (req.intent.relayer !== sponsor.address) throw new RelayerError("POLICY_DENIED", "intent must name this relayer");
    if (req.intent.relayerFee !== "0" || req.intent.relayerFeeTokenAccount !== null) throw new RelayerError("POLICY_DENIED", "this relayer charges no token fee");
    const expectedAta = (await associatedTokenAddress(address(req.intent.destinationOwner), mint)).address;
    if (req.intent.destinationTokenAccount !== expectedAta) throw new RelayerError("POLICY_DENIED", "destination must be the destination owner's exact-mint ATA");
    const derived = intentContext(
      { programId: addressBytes(program), pool: addressBytes(poolState), genesisHash: hexToBytes(manifest.network.genesisHashHex), mint: addressBytes(mint) },
      toIntent(req.intent),
    );
    if (derived.context !== context) throw new RelayerError("POLICY_DENIED", "public context does not match the intent");
    if (derived.withdrawnValue !== withdrawn) throw new RelayerError("POLICY_DENIED", "withdrawn value does not match the intent");
    if (newCommitment === 0n) throw new RelayerError("POLICY_DENIED", "new commitment must be nonzero");
    if (!(await verifyProof(this.c.spendVk, req.publicSignals, req.proof as Groth16Proof))) throw new RelayerError("POLICY_DENIED", "spend proof does not verify");

    const nfHex = Buffer.from(toBe32(nullifierHash)).toString("hex");
    try {
      this.c.db
        .prepare(
          `INSERT INTO withdrawal (id, nullifier_hash, request_json, destination_owner, destination_ata, valid_until_slot, sponsor_cap, state, checked_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, ?, ?)`,
        )
        .run(req.withdrawalId, nfHex, canonicalJson(req), req.intent.destinationOwner, expectedAta, BigInt(req.intent.validUntilSlot), BigInt(req.sponsorLamportCap), this.now, this.now);
    } catch (error) {
      if (String((error as Error).message).includes("UNIQUE")) throw new RelayerError("IDEMPOTENCY_CONFLICT", "a live withdrawal for this nullifier already exists");
      throw error;
    }
    await this.advanceOrReport(req.withdrawalId);
    return this.view(req.withdrawalId)!;
  }

  /** Runs a recorded request forward; a chain-check rejection is returned to the caller. */
  private async advanceOrReport(id: string): Promise<void> {
    try {
      await this.advance(id);
    } catch (error) {
      if (error instanceof RelayerError) throw error;
      // A failed chain read leaves the request recorded and unchecked; the loop retries it.
      this.set(id, { error: `chain checks pending (${(error as Error).name})` });
    }
    const r = this.row(id)!;
    if (r.state === "rejected") {
      const code = (r.error ?? "").split(":")[0] as ApiErrorCode;
      throw new RelayerError(code in API_ERROR_STATUS ? code : "POLICY_DENIED", r.error ?? "withdrawal rejected");
    }
  }

  private attemptCount(id: string): bigint {
    return this.c.db.prepare(`SELECT count(*) FROM withdrawal_attempt WHERE withdrawal_id = ?`).pluck().get(id) as bigint;
  }

  /**
   * Chain checks for a recorded, not yet checked request: slot bound, known state root,
   * current approved root, unused nullifier and sponsor caps. A failed check marks the
   * request rejected (nothing was sent); a failed read throws and leaves it unchecked.
   */
  private async chainCheck(r: WithdrawalRow, manifest: DeploymentManifest): Promise<boolean> {
    const req = JSON.parse(r.request_json) as WithdrawalRequestWire;
    const ps = req.publicSignals.map(parseDecimal);
    const [, stateRoot, approvedRoot, nullifierHash] = ps as [bigint, bigint, bigint, bigint];
    const program = address(manifest.program.programId);
    const poolState = address(manifest.pool.poolState);
    const reject = (code: ApiErrorCode, message: string) => {
      this.set(r.id, { state: "rejected", error: `${code}: ${message}` });
      return false;
    };
    const slot = await this.c.chain.finalizedSlot();
    const poolAcct = await this.c.chain.account(poolState);
    const apprAcct = await this.c.chain.account(address(manifest.pool.approvalState));
    if (!poolAcct || !apprAcct) return reject("NOT_READY", "pool accounts not visible");
    const pool = decodePoolState(poolAcct.data);
    try {
      validateIntent(toIntent(req.intent), pool.maxRelayerFee, slot);
    } catch (error) {
      if (error instanceof IntentError) return reject("POLICY_DENIED", `intent rejected: ${error.code}`);
      throw error;
    }
    if (!knownRoots(pool).includes(stateRoot)) return reject("NOTE_PENDING", "state root is not in the on-chain root history");
    if (decodeApprovalState(apprAcct.data).approvedRoot !== approvedRoot) return reject("NOTE_PENDING", "approved root is not the current on-chain approved root");
    const nfPda = await spentNullifierPda(program, poolState, toBe32(nullifierHash));
    if (await this.c.chain.account(nfPda.address)) return reject("IDEMPOTENCY_CONFLICT", "nullifier is already spent");
    const ataExists = (await this.c.chain.account(address(r.destination_ata))) !== null;
    const rent = ataExists ? 0n : await this.c.chain.rentExemptMinimum(TOKEN_ACCOUNT_SIZE);
    const estimate = rent + LAMPORTS_PER_SIGNATURE * (ataExists ? 1n : 2n);
    if (estimate > r.sponsor_cap) return reject("BUDGET_EXCEEDED", "sponsor cost exceeds this withdrawal's sponsor cap");
    const totals = sponsorTotals(this.c.db);
    if (totals.feesSpent + totals.rentOutstanding + estimate > this.c.sponsorCapLamports) return reject("BUDGET_EXCEEDED", "sponsor lamport allowance exhausted");
    this.set(r.id, { checked_at_ms: BigInt(this.now), error: null });
    return true;
  }

  private set(id: string, fields: Record<string, unknown>): void {
    const keys = Object.keys(fields);
    this.c.db.prepare(`UPDATE withdrawal SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at_ms = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), this.now, id);
  }

  private attempt(id: string, leg: "ata" | "spend", signature: string, blockhash: string, lastValid: bigint): void {
    const n = this.c.db.prepare(`SELECT count(*) FROM withdrawal_attempt WHERE withdrawal_id = ? AND leg = ?`).pluck().get(id, leg) as bigint;
    this.c.db
      .prepare(`INSERT INTO withdrawal_attempt (withdrawal_id, leg, attempt_no, signature, blockhash, last_valid_block_height, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, leg, n + 1n, signature, blockhash, lastValid, this.now);
  }

  /** Drives one withdrawal forward from chain evidence. Safe to call repeatedly and after restart. */
  async advance(id: string): Promise<void> {
    const r = this.row(id);
    if (!r || ["finalized", "failed", "expired", "rejected"].includes(r.state)) return;
    const { manifest, sponsor } = this.ready();
    const mint = address(manifest.token.mint);
    const ata = address(r.destination_ata);
    const req = JSON.parse(r.request_json) as WithdrawalRequestWire;
    const chain = this.c.chain;

    // An unchecked request is checked against the chain before anything is sent.
    if (r.state === "accepted" && r.checked_at_ms === null && !(await this.chainCheck(r, manifest))) return;
    if (r.state === "accepted" || r.state === "ata_submitted") {
      if (await chain.account(ata)) {
        if (r.ata_signature) {
          const tx = await chain.transaction(r.ata_signature);
          if (tx) recordSponsorEvent(this.c.db, "fee_spent", `withdrawal:${id}`, r.ata_signature, tx.fee);
          recordSponsorEvent(this.c.db, "rent_outstanding", `withdrawal:${id}`, r.ata_signature, (await chain.account(ata))!.lamports);
        }
        return this.sendSpend(r, req, manifest, sponsor);
      }
      if (r.ata_signature && r.ata_last_valid_block_height !== null) {
        const st = await chain.signatureStatus(r.ata_signature);
        if (st && st.err === null) return;
        if (!st && (await chain.finalizedBlockHeight()) <= r.ata_last_valid_block_height) return;
      }
      const bh = await chain.latestBlockhash();
      const signed = await sponsorSignedTx(sponsor, bh, [
        getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(sponsor.address), ata, owner: address(r.destination_owner), mint }),
      ]);
      this.c.db.transaction(() => {
        this.attempt(id, "ata", signed.signature, signed.blockhash, signed.lastValidBlockHeight);
        this.set(id, { state: "ata_submitted", ata_signature: signed.signature, ata_blockhash: signed.blockhash, ata_last_valid_block_height: signed.lastValidBlockHeight });
      })();
      await chain.send(signed.wire).catch(() => undefined);
      return;
    }

    if (r.state === "submitted" && r.signature && r.last_valid_block_height !== null) {
      const st = await chain.signatureStatus(r.signature);
      if (st?.confirmationStatus === "finalized") {
        const tx = await chain.transaction(r.signature);
        if (tx) recordSponsorEvent(this.c.db, "fee_spent", `withdrawal:${id}`, r.signature, tx.fee);
        if (st.err === null) this.set(id, { state: "finalized", finalized_slot: tx?.slot ?? null });
        else this.set(id, { state: "failed", error: "spend transaction failed on-chain" });
        return;
      }
      if (st) return;
      if ((await chain.finalizedBlockHeight()) <= r.last_valid_block_height) return;
      // The attempt can no longer land. Retry only while the proof's slot bound allows it.
      const program = address(manifest.program.programId);
      const nf = await spentNullifierPda(program, address(manifest.pool.poolState), hexToBytes(r.nullifier_hash));
      if (await chain.account(nf.address)) {
        this.set(id, { state: "failed", error: "nullifier was spent by another transaction" });
        return;
      }
      if ((await chain.finalizedSlot()) > r.valid_until_slot) {
        this.set(id, { state: "expired", error: "intent slot bound passed before settlement" });
        return;
      }
      return this.sendSpend(r, req, manifest, sponsor);
    }
  }

  private async sendSpend(r: WithdrawalRow, req: WithdrawalRequestWire, manifest: DeploymentManifest, sponsor: SponsorKey): Promise<void> {
    const program = address(manifest.program.programId);
    const poolState = address(manifest.pool.poolState);
    const ps = req.publicSignals.map(parseDecimal);
    const nfBe = toBe32(ps[3]!);
    const ix = spendPrivateInstruction(
      program,
      {
        payer: sponsor.address,
        relayer: sponsor.address,
        poolState,
        approvalState: address(manifest.pool.approvalState),
        vault: address(manifest.pool.vault),
        vaultAuthority: address(manifest.pool.vaultAuthority),
        destination: address(r.destination_ata),
        relayerFeeAccount: null,
        spentNullifier: (await spentNullifierPda(program, poolState, nfBe)).address,
        pendingChange: (await pendingChangePda(program, poolState, nfBe)).address,
      },
      { proof: toSolanaProof(req.proof as Groth16Proof), stateRoot: ps[1]!, nullifierHash: ps[3]!, newCommitment: ps[5]!, intent: toIntent(req.intent) },
    );
    const bh = await this.c.chain.latestBlockhash();
    const signed = await sponsorSignedTx(sponsor, bh, [getSetComputeUnitLimitInstruction({ units: 400_000 }), ix]);
    this.c.db.transaction(() => {
      this.attempt(r.id, "spend", signed.signature, signed.blockhash, signed.lastValidBlockHeight);
      this.set(r.id, { state: "submitted", signature: signed.signature, blockhash: signed.blockhash, last_valid_block_height: signed.lastValidBlockHeight, attempts: r.attempts + 1n });
    })();
    await this.c.chain.send(signed.wire).catch(() => undefined);
  }

  pendingIds(): string[] {
    return this.c.db.prepare(`SELECT id FROM withdrawal WHERE state IN ('accepted', 'ata_submitted', 'submitted') ORDER BY created_at_ms`).pluck().all() as string[];
  }
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const addrEnc = getAddressEncoder();

function verifyEd25519(addr: string, message: Uint8Array, sig: Uint8Array): boolean {
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(addrEnc.encode(addr as Address))]), format: "der", type: "spki" });
  return edVerify(null, Buffer.from(message), key, Buffer.from(sig));
}

/**
 * Co-signs owner recovery transactions as fee payer. Accepted only if the transaction moves the
 * fresh wallet's tokens to the stated destination and closes its ATA with rent to the sponsor,
 * with nothing else and a valid fresh-wallet signature.
 */
export class RecoveryService {
  constructor(private readonly c: RelayerContext) {}

  view(id: string): RecoveryViewWire | null {
    const r = this.c.db.prepare(`SELECT * FROM recovery WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      recoveryId: r.id as string,
      state: r.state as RecoveryViewWire["state"],
      signature: r.signature as string,
      blockhash: r.blockhash as string,
      lastValidBlockHeight: String(r.last_valid_block_height),
      sponsorFeeLamports: String(r.fee_lamports),
      rentRecoveredLamports: r.state === "finalized" ? String(r.rent_lamports) : "0",
      error: (r.error as string | null) ?? null,
    };
  }

  async submit(req: RecoveryRequestWire): Promise<RecoveryViewWire> {
    const prior = this.view(req.recoveryId);
    if (prior) return prior;
    const manifest = this.c.manifest();
    const sponsor = this.c.sponsor;
    if (!manifest || !sponsor) throw new RelayerError("NOT_READY", "deployment or sponsor not ready");
    const mint = address(manifest.token.mint);
    const fresh = address(req.freshWallet);
    const freshAta = (await associatedTokenAddress(fresh, mint)).address;
    const tx = decodeWireTransaction(req.transaction);
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const keys = msg.staticAccounts;
    if (keys[0] !== sponsor.address) throw new RelayerError("POLICY_DENIED", "sponsor must be the fee payer");
    const ixs = msg.instructions.map((i) => ({ program: keys[i.programAddressIndex], accounts: (i.accountIndices ?? []).map((k) => keys[k]), data: new Uint8Array(i.data ?? []) }));
    const amount = BigInt(req.amount);
    const expected = amount > 0n ? ["transfer", "close"] : ["close"];
    if (ixs.length !== expected.length) throw new RelayerError("POLICY_DENIED", "recovery transaction has unexpected instructions");
    for (const [n, ix] of ixs.entries()) {
      if (ix.program !== TOKEN_PROGRAM_ID) throw new RelayerError("POLICY_DENIED", "recovery may use only the SPL Token program");
      if (expected[n] === "transfer") {
        const amt = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true);
        const ok = ix.data.length === 10 && ix.data[0] === 12 && amt === amount && ix.data[9] === manifest.token.decimals &&
          ix.accounts[0] === freshAta && ix.accounts[1] === mint && ix.accounts[2] === req.destinationAta && ix.accounts[3] === fresh && ix.accounts.length === 4;
        if (!ok) throw new RelayerError("POLICY_DENIED", "recovery transfer does not match the request");
      } else {
        const ok = ix.data.length === 1 && ix.data[0] === 9 && ix.accounts.length === 3 && ix.accounts[0] === freshAta && ix.accounts[1] === sponsor.address && ix.accounts[2] === fresh;
        if (!ok) throw new RelayerError("POLICY_DENIED", "ATA close must return rent to the sponsor");
      }
    }
    const freshSig = tx.signatures[fresh];
    if (!freshSig || !verifyEd25519(fresh, new Uint8Array(tx.messageBytes), freshSig)) throw new RelayerError("POLICY_DENIED", "fresh wallet signature is missing or invalid");
    const ataAcct = await this.c.chain.account(freshAta);
    if (!ataAcct) throw new RelayerError("NOT_READY", "fresh wallet token account not found");
    const blockhash = (msg.lifetimeToken as string) ?? "";
    const signed = await sponsorCosign(sponsor, tx, { blockhash, lastValidBlockHeight: BigInt(req.lastValidBlockHeight) });
    const now = Date.now();
    this.c.db
      .prepare(
        `INSERT INTO recovery (id, fresh_wallet, destination_ata, amount, signature, blockhash, last_valid_block_height, rent_lamports, state, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`,
      )
      .run(req.recoveryId, fresh, req.destinationAta, amount, signed.signature, blockhash, BigInt(req.lastValidBlockHeight), ataAcct.lamports, now, now);
    await this.c.chain.send(signed.wire).catch(() => undefined);
    return this.view(req.recoveryId)!;
  }

  async advance(id: string): Promise<void> {
    const r = this.c.db.prepare(`SELECT * FROM recovery WHERE id = ?`).get(id) as { signature: string; state: string; last_valid_block_height: bigint; rent_lamports: bigint } | undefined;
    if (!r || r.state !== "submitted") return;
    const st = await this.c.chain.signatureStatus(r.signature);
    if (st?.confirmationStatus === "finalized") {
      const tx = await this.c.chain.transaction(r.signature);
      const fee = tx?.fee ?? 0n;
      this.c.db.transaction(() => {
        recordSponsorEvent(this.c.db, "fee_spent", `recovery:${id}`, r.signature, fee);
        if (st.err === null) recordSponsorEvent(this.c.db, "rent_recovered", `recovery:${id}`, r.signature, r.rent_lamports);
        this.c.db.prepare(`UPDATE recovery SET state = ?, fee_lamports = ?, updated_at_ms = ? WHERE id = ?`).run(st.err === null ? "finalized" : "failed", fee, Date.now(), id);
      })();
      return;
    }
    if (!st && (await this.c.chain.finalizedBlockHeight()) > r.last_valid_block_height) {
      this.c.db.prepare(`UPDATE recovery SET state = 'expired', updated_at_ms = ? WHERE id = ?`).run(Date.now(), id);
    }
  }

  pendingIds(): string[] {
    return this.c.db.prepare(`SELECT id FROM recovery WHERE state = 'submitted'`).pluck().all() as string[];
  }
}
