import { address, getCompiledTransactionMessageDecoder, type Address } from "@solana/kit";
import { getSwapV2InstructionDataDecoder, SWAP_V2_DISCRIMINATOR } from "@orca-so/whirlpools-client";
import { DEVNET_SOL_USDC_WHIRLPOOL, ORCA_WHIRLPOOL_PROGRAM, WRAPPED_SOL_MINT } from "@veilo/contracts";
import type { SwapRequestWire, SwapViewWire } from "@veilo/contracts/relayer";
import { associatedTokenAddress } from "@veilo/privacy-sdk";
import { decodeWireTransaction } from "@veilo/x402-client";
import { recordSponsorEvent, sponsorTotals } from "./db";
import { sponsorCosign } from "./sponsor";
import { LAMPORTS_PER_SIGNATURE, RelayerError, TOKEN_ACCOUNT_SIZE, verifyEd25519, type RelayerContext } from "./withdrawals";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

interface Ix {
  program: Address;
  accounts: Address[];
  data: Uint8Array;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Co-signs the devnet swap as fee payer. Accepted only as exactly: a compute-unit limit; the
 * sponsor creating the fresh wallet's wrapped-SOL account; one Orca swapV2 of devnet USDC into
 * wrapped SOL on the pinned whirlpool, authorized by the fresh wallet; closing the wrapped-SOL
 * account to the stated destination; and closing the emptied USDC account with rent to the
 * sponsor. Nothing else, with a valid fresh-wallet signature and within the sponsor allowance.
 */
export class SwapService {
  constructor(private readonly c: RelayerContext) {}

  view(id: string): SwapViewWire | null {
    const r = this.c.db.prepare(`SELECT * FROM swap WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      swapId: r.id as string,
      state: r.state as SwapViewWire["state"],
      signature: r.signature as string,
      lastValidBlockHeight: String(r.last_valid_block_height),
      sponsorFeeLamports: String(r.fee_lamports),
      sponsorRentLamports: String(r.wsol_rent_lamports),
      rentRecoveredLamports: r.state === "finalized" ? String(r.usdc_rent_lamports) : "0",
      ...(r.actual_out_lamports !== null && r.actual_out_lamports !== undefined ? { actualOutLamports: String(r.actual_out_lamports) } : {}),
      error: (r.error as string | null) ?? null,
    };
  }

  /** Backfills finalized historical swaps without signing or broadcasting anything. */
  async receipt(id: string): Promise<SwapViewWire | null> {
    const view = this.view(id);
    if (view?.state === "finalized" && view.actualOutLamports === undefined) {
      const row = this.c.db.prepare(`SELECT fresh_wallet FROM swap WHERE id = ?`).get(id) as { fresh_wallet: string };
      const tx = await this.c.chain.transaction(view.signature);
      if (tx && tx.err === null) {
        const ata = (await associatedTokenAddress(address(row.fresh_wallet), address(WRAPPED_SOL_MINT))).address;
        const transfers = (tx.tokenTransfers ?? []).filter((t) => t.mint === WRAPPED_SOL_MINT && t.destination === ata);
        if (transfers.length === 1) this.c.db.prepare(`UPDATE swap SET actual_out_lamports = ? WHERE id = ?`).run(transfers[0]!.amount, id);
      }
    }
    return this.view(id);
  }

  async submit(req: SwapRequestWire): Promise<SwapViewWire> {
    const prior = this.view(req.swapId);
    if (prior) return prior;
    const manifest = this.c.manifest();
    const sponsor = this.c.sponsor;
    if (!manifest || !sponsor) throw new RelayerError("NOT_READY", "deployment or sponsor not ready");
    const usdc = address(manifest.token.mint);
    const fresh = address(req.freshWallet);
    const freshUsdc = (await associatedTokenAddress(fresh, usdc)).address;
    const freshWsol = (await associatedTokenAddress(fresh, address(WRAPPED_SOL_MINT))).address;

    const tx = decodeWireTransaction(req.transaction);
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if ("addressTableLookups" in msg && (msg.addressTableLookups?.length ?? 0) > 0) throw new RelayerError("POLICY_DENIED", "swap may not use address lookup tables");
    const keys = msg.staticAccounts;
    if (keys[0] !== sponsor.address) throw new RelayerError("POLICY_DENIED", "sponsor must be the fee payer");
    const ixs: Ix[] = msg.instructions.map((i) => ({ program: keys[i.programAddressIndex]!, accounts: (i.accountIndices ?? []).map((k) => keys[k]!), data: new Uint8Array(i.data ?? []) }));
    if (ixs.length !== 5) throw new RelayerError("POLICY_DENIED", "swap transaction has unexpected instructions");
    const [budget, createWsol, swap, closeWsol, closeUsdc] = ixs as [Ix, Ix, Ix, Ix, Ix];

    if (budget.program !== COMPUTE_BUDGET_PROGRAM || budget.data[0] !== 2 || budget.data.length !== 5 || budget.accounts.length !== 0) {
      throw new RelayerError("POLICY_DENIED", "first instruction must set the compute-unit limit");
    }
    const c = createWsol.accounts;
    if (createWsol.program !== ATA_PROGRAM || !sameBytes(createWsol.data, new Uint8Array([1])) || c.length !== 6 ||
      c[0] !== sponsor.address || c[1] !== freshWsol || c[2] !== fresh || c[3] !== WRAPPED_SOL_MINT || c[4] !== SYSTEM_PROGRAM || c[5] !== TOKEN_PROGRAM) {
      throw new RelayerError("POLICY_DENIED", "wrapped-SOL account must be the fresh wallet's, created by the sponsor");
    }
    const s = swap.accounts;
    if (swap.program !== ORCA_WHIRLPOOL_PROGRAM || !sameBytes(swap.data.subarray(0, 8), SWAP_V2_DISCRIMINATOR)) throw new RelayerError("POLICY_DENIED", "swap must be one Orca swapV2");
    if (s[3] !== fresh || s[4] !== DEVNET_SOL_USDC_WHIRLPOOL || s[5] !== WRAPPED_SOL_MINT || s[6] !== usdc || s[7] !== freshWsol || s[9] !== freshUsdc) {
      throw new RelayerError("POLICY_DENIED", "swap must use the pinned whirlpool and the fresh wallet's own token accounts");
    }
    const args = getSwapV2InstructionDataDecoder().decode(swap.data);
    if (args.aToB || !args.amountSpecifiedIsInput || args.amount <= 0n || args.otherAmountThreshold <= 0n) {
      throw new RelayerError("POLICY_DENIED", "swap must sell an exact USDC amount for a positive minimum of SOL");
    }
    const w = closeWsol.accounts;
    if (closeWsol.program !== TOKEN_PROGRAM || !sameBytes(closeWsol.data, new Uint8Array([9])) || w.length !== 3 || w[0] !== freshWsol || w[1] !== req.destination || w[2] !== fresh) {
      throw new RelayerError("POLICY_DENIED", "wrapped SOL must be unwrapped to the stated destination");
    }
    const u = closeUsdc.accounts;
    if (closeUsdc.program !== TOKEN_PROGRAM || !sameBytes(closeUsdc.data, new Uint8Array([9])) || u.length !== 3 || u[0] !== freshUsdc || u[1] !== sponsor.address || u[2] !== fresh) {
      throw new RelayerError("POLICY_DENIED", "emptied USDC account must return rent to the sponsor");
    }

    const freshSig = tx.signatures[fresh];
    if (!freshSig || !verifyEd25519(fresh, new Uint8Array(tx.messageBytes), freshSig)) throw new RelayerError("POLICY_DENIED", "fresh wallet signature is missing or invalid");
    const usdcAcct = await this.c.chain.account(freshUsdc);
    if (!usdcAcct) throw new RelayerError("NOT_READY", "fresh wallet USDC account not found");
    const wsolRent = await this.c.chain.rentExemptMinimum(TOKEN_ACCOUNT_SIZE);
    this.#assertWithinCap(wsolRent);

    const blockhash = (msg.lifetimeToken as string) ?? "";
    const signed = await sponsorCosign(sponsor, tx, { blockhash, lastValidBlockHeight: BigInt(req.lastValidBlockHeight) });
    const now = Date.now();
    // Rechecked and recorded in one synchronous transaction, so concurrent swaps cannot both fit
    // and a concurrent retry of the same swap id neither re-broadcasts nor counts against the cap.
    const inserted = this.c.db.transaction(() => {
      if (this.c.db.prepare(`SELECT 1 FROM swap WHERE id = ?`).get(req.swapId)) return false;
      this.#assertWithinCap(wsolRent);
      this.c.db
        .prepare(
          `INSERT INTO swap (id, fresh_wallet, destination, signature, blockhash, last_valid_block_height, wsol_rent_lamports, usdc_rent_lamports, state, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`,
        )
        .run(req.swapId, fresh, req.destination, signed.signature, blockhash, BigInt(req.lastValidBlockHeight), wsolRent, usdcAcct.lamports, now, now);
      return true;
    })();
    if (inserted) await this.c.chain.send(signed.wire).catch(() => undefined);
    return this.view(req.swapId)!;
  }

  /** Counts swaps still in flight at their worst case (wSOL rent kept, two signature fees). */
  #assertWithinCap(wsolRent: bigint): void {
    const totals = sponsorTotals(this.c.db);
    const inFlight = this.c.db
      .prepare(`SELECT COALESCE(SUM(wsol_rent_lamports), 0) AS rent, COUNT(*) AS n FROM swap WHERE state = 'submitted'`)
      .get() as { rent: bigint; n: bigint };
    const pending = BigInt(inFlight.rent) + BigInt(inFlight.n) * 2n * LAMPORTS_PER_SIGNATURE;
    if (totals.feesSpent + totals.rentOutstanding + pending + wsolRent + 2n * LAMPORTS_PER_SIGNATURE > this.c.sponsorCapLamports) {
      throw new RelayerError("BUDGET_EXCEEDED", "sponsor lamport allowance exhausted");
    }
  }

  async advance(id: string): Promise<void> {
    const r = this.c.db.prepare(`SELECT * FROM swap WHERE id = ?`).get(id) as
      | { signature: string; state: string; last_valid_block_height: bigint; wsol_rent_lamports: bigint; usdc_rent_lamports: bigint }
      | undefined;
    if (!r || r.state !== "submitted") return;
    const st = await this.c.chain.signatureStatus(r.signature);
    if (st?.confirmationStatus === "finalized") {
      // Finalized only with the fee read from the transaction itself; otherwise retried next crank.
      const tx = await this.c.chain.transaction(r.signature);
      if (!tx) return;
      const fee = tx.fee;
      this.c.db.transaction(() => {
        recordSponsorEvent(this.c.db, "fee_spent", `swap:${id}`, r.signature, fee);
        if (st.err === null) {
          recordSponsorEvent(this.c.db, "rent_outstanding", `swap:${id}`, r.signature, r.wsol_rent_lamports);
          recordSponsorEvent(this.c.db, "rent_recovered", `swap:${id}`, r.signature, r.usdc_rent_lamports);
        }
        this.c.db
          .prepare(`UPDATE swap SET state = ?, fee_lamports = ?, error = ?, updated_at_ms = ? WHERE id = ?`)
          .run(st.err === null ? "finalized" : "failed", fee, st.err === null ? null : "swap transaction failed on-chain", Date.now(), id);
      })();
      return;
    }
    if (!st && (await this.c.chain.finalizedBlockHeight()) > r.last_valid_block_height) {
      this.c.db.prepare(`UPDATE swap SET state = 'expired', updated_at_ms = ? WHERE id = ?`).run(Date.now(), id);
    }
  }

  pendingIds(): string[] {
    return this.c.db.prepare(`SELECT id FROM swap WHERE state = 'submitted'`).pluck().all() as string[];
  }
}
