import {
  DEVNET_SOL_USDC_WHIRLPOOL,
  parseBaseUnits,
  SPONSOR_LAMPORTS_PER_PRIVATE_PURCHASE,
  SWAP_SLIPPAGE_BPS,
  WRAPPED_SOL_MINT,
  type FundingBinding,
  type FundingProvider,
  type SwapResult,
} from "@veilo/contracts";
import { immediate } from "@veilo/db";
import { big, type Ledger } from "../context";
import { ControlError } from "../errors";
import { writeAudit } from "../ledger/events";
import { advanceAuthority, markRecoverable, recordMerchantFinalized, transition, type PurchaseRow } from "../ledger/purchases";

export const SWAP_SERVICE_KEY = "swap:orca-devnet-sol-usdc";
export const SWAP_SKU = "swap-usdc-to-sol";
const SWAP_ORIGIN = "https://api.devnet.orca.so";
/** The funding withdrawal, plus the wrapped-SOL account rent and both swap signatures the sponsor pays. */
const SWAP_SPONSOR_LAMPORTS = SPONSOR_LAMPORTS_PER_PRIVATE_PURCHASE + 2_039_280n + 10_000n;
/** Largest single swap an owner may approve; the devnet pool is shallow. */
export const MAX_SWAP_USDC = 5_000_000n;

/**
 * Owner approval of the devnet swap on the pinned Orca whirlpool, USDC to SOL delivered to the
 * owner's configured address. The SKU price is the maximum per swap; each purchase is priced at
 * the amount the agent requested within it. Re-approving changes only that maximum.
 */
export function approveSwapService(ledger: Ledger, workspaceId: string, amountUsdc: bigint, ownerId: string): { serviceId: string } {
  if (amountUsdc <= 0n || amountUsdc > MAX_SWAP_USDC) throw new ControlError("INVALID_REQUEST", `swap amount must be between 1 base unit and ${MAX_SWAP_USDC} base units`);
  return immediate(ledger.db, () => {
    const now = ledger.now();
    const ws = ledger.db.prepare(`SELECT network, mint FROM workspace WHERE id = ?`).get(workspaceId) as { network: string; mint: string } | undefined;
    if (!ws) throw new ControlError("NOT_FOUND", "workspace not found");
    let serviceId = ledger.db.prepare(`SELECT id FROM approved_service WHERE workspace_id = ? AND service_key = ?`).pluck().get(workspaceId, SWAP_SERVICE_KEY) as string | undefined;
    if (serviceId === undefined) {
      serviceId = ledger.newId();
      ledger.db
        .prepare(
          `INSERT INTO approved_service (id, workspace_id, service_key, origin, gateway_identity, recipient, recipient_ata, network, mint,
             status, description, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'orca:devnet', ?, ?, ?, ?, 'approved', ?, ?, ?)`,
        )
        .run(serviceId, workspaceId, SWAP_SERVICE_KEY, SWAP_ORIGIN, DEVNET_SOL_USDC_WHIRLPOOL, DEVNET_SOL_USDC_WHIRLPOOL, ws.network, ws.mint,
          "Orca devnet swap: USDC to SOL, delivered to the owner's address", now, now);
      ledger.db
        .prepare(`INSERT INTO service_sku (id, service_id, sku, payment_path, price_usdc, max_fee_usdc, usage_units, sponsor_lamports) VALUES (?, ?, ?, 'private_x402', ?, 0, 0, ?)`)
        .run(ledger.newId(), serviceId, SWAP_SKU, amountUsdc, SWAP_SPONSOR_LAMPORTS);
    } else {
      ledger.db.prepare(`UPDATE approved_service SET status = 'approved', updated_at_ms = ? WHERE id = ?`).run(now, serviceId);
      ledger.db.prepare(`UPDATE service_sku SET price_usdc = ?, sponsor_lamports = ? WHERE service_id = ? AND sku = ?`).run(amountUsdc, SWAP_SPONSOR_LAMPORTS, serviceId, SWAP_SKU);
    }
    writeAudit(ledger, {
      workspaceId,
      scope: `service:${serviceId}`,
      actorType: "owner",
      actorId: ownerId,
      action: "swap.approve",
      policyResult: "allowed",
      details: { amountUsdc: amountUsdc.toString(), whirlpool: DEVNET_SOL_USDC_WHIRLPOOL },
    });
    return { serviceId };
  });
}

/**
 * The USDC amount from an agent's swap input, the only term an agent supplies. Any other field
 * (pool, direction, slippage, destination) is refused rather than ignored.
 */
export function swapInputAmount(input: unknown): bigint {
  const keys = input !== null && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
  if (keys.length !== 1 || keys[0] !== "amountUsdc") {
    throw new ControlError("SERVICE_NOT_ALLOWED", "a swap input carries only amountUsdc; the owner fixed the pool, direction and destination");
  }
  let amount: bigint;
  try {
    amount = parseBaseUnits((input as { amountUsdc: unknown }).amountUsdc);
  } catch {
    throw new ControlError("INVALID_REQUEST", "amountUsdc must be a whole number of USDC base units as a decimal string");
  }
  if (amount <= 0n) throw new ControlError("INVALID_REQUEST", "swap amount must be at least 1 base unit");
  return amount;
}

/**
 * Withdraws the owner's swap approval: new swap purchases are refused at authorization, while
 * swaps already authorized settle or recover as before.
 */
export function disableSwapService(ledger: Ledger, workspaceId: string, ownerId: string): { serviceId: string | null } {
  return immediate(ledger.db, () => {
    const serviceId = ledger.db.prepare(`SELECT id FROM approved_service WHERE workspace_id = ? AND service_key = ?`).pluck().get(workspaceId, SWAP_SERVICE_KEY) as string | undefined;
    if (serviceId === undefined) return { serviceId: null };
    ledger.db.prepare(`UPDATE approved_service SET status = 'disabled', updated_at_ms = ? WHERE id = ?`).run(ledger.now(), serviceId);
    writeAudit(ledger, {
      workspaceId,
      scope: `service:${serviceId}`,
      actorType: "owner",
      actorId: ownerId,
      action: "swap.disable",
      policyResult: "allowed",
      details: {},
    });
    return { serviceId };
  });
}

/** The binding the wallet stores at prepare time and deep-compares before it signs the swap. */
export function swapFundingBinding(p: PurchaseRow, network: string, mint: string): FundingBinding {
  return {
    origin: SWAP_ORIGIN,
    gatewayIdentity: "orca:devnet",
    sku: p.sku,
    network,
    mint,
    payTo: DEVNET_SOL_USDC_WHIRLPOOL,
    merchantAta: DEVNET_SOL_USDC_WHIRLPOOL,
    allowedFeePayers: [],
    swap: { dex: "orca_whirlpool", whirlpool: DEVNET_SOL_USDC_WHIRLPOOL, inputMint: mint, outputMint: WRAPPED_SOL_MINT, slippageBps: SWAP_SLIPPAGE_BPS },
  };
}

/**
 * Drives the swap leg after private funding finalized: records sign_merchant (which rechecks
 * authority), asks the wallet to sign the one swap, and settles from chain evidence. A swap
 * that failed or expired leaves the USDC in the fresh wallet, recoverable by the owner.
 */
export class SwapRunner {
  constructor(
    private readonly ledger: Ledger,
    private readonly funding: FundingProvider,
  ) {}

  async step(p: PurchaseRow, binding: FundingBinding): Promise<boolean> {
    if (p.merchant_state === "not_started") {
      advanceAuthority(this.ledger, p.id, "sign_merchant");
      return true;
    }
    if (p.merchant_state !== "signed") return false;
    const sign = this.funding.signSwap;
    if (!sign) throw new ControlError("NOT_READY", "the funding provider cannot sign swaps");
    const r = await sign.call(this.funding, p.id, p.id, binding);
    if (r.status === "not_ready") throw new ControlError("NOT_READY", `swap not signed yet: ${r.reason}`);
    // The merchant leg stays signed: the wallet's refusal alone does not prove whether a swap signature exists.
    if (r.status === "recovery_required") throw new ControlError("RECOVERY_REQUIRED", `swap refused by the wallet: ${r.reason}`);
    this.#recordAttempt(p.id, r);
    if (r.status === "submitted") return false;
    if (r.status === "finalized") this.#finish(p, r);
    else this.#fail(p, r);
    return false;
  }

  #recordAttempt(purchaseId: string, r: Exclude<SwapResult, { status: "not_ready" | "recovery_required" }>): void {
    const now = this.ledger.now();
    this.ledger.db
      .prepare(`UPDATE purchase_execution SET result_json = ?, updated_at_ms = ? WHERE purchase_id = ?`)
      .run(JSON.stringify(swapResultView(r)), now, purchaseId);
    if (r.signature === null) return;
    this.ledger.db
      .prepare(
        `INSERT OR IGNORE INTO chain_attempt (id, purchase_id, leg, attempt_no, signature, observed_commitment, observed_at_ms, created_at_ms)
         VALUES (?, ?, 'merchant', 1, ?, ?, ?, ?)`,
      )
      .run(this.ledger.newId(), purchaseId, r.signature, r.status === "finalized" ? "finalized" : r.status === "failed" ? "failed" : "unknown", now, now);
    this.ledger.db
      .prepare(`UPDATE chain_attempt SET observed_commitment = ?, observed_at_ms = ? WHERE purchase_id = ? AND leg = 'merchant' AND attempt_no = 1`)
      .run(r.status === "finalized" ? "finalized" : r.status === "failed" ? "failed" : "unknown", now, purchaseId);
  }

  #finish(p: PurchaseRow, r: Extract<SwapResult, { status: "finalized" }>): void {
    immediate(this.ledger.db, () => {
      const ex = this.ledger.db
        .prepare(`SELECT funding_token_fees, sponsor_lamports_spent FROM purchase_execution WHERE purchase_id = ?`)
        .get(p.id) as { funding_token_fees: bigint | null; sponsor_lamports_spent: bigint | null };
      recordMerchantFinalized(this.ledger, p.id, {
        merchantAmount: big(p.price_usdc),
        tokenFees: ex.funding_token_fees === null ? 0n : big(ex.funding_token_fees),
        sponsorLamports: (ex.sponsor_lamports_spent === null ? 0n : big(ex.sponsor_lamports_spent)) + r.sponsorLamports,
        settledAtMs: this.ledger.now(),
      });
      transition(this.ledger, p.id, "fulfilment", "not_started", "in_progress");
      transition(this.ledger, p.id, "fulfilment", "in_progress", "delivered");
      this.ledger.db.prepare(`UPDATE purchase_execution SET gateway_state = 'delivered', updated_at_ms = ? WHERE purchase_id = ?`).run(this.ledger.now(), p.id);
    });
  }

  #fail(p: PurchaseRow, r: Extract<SwapResult, { status: "failed" }>): void {
    immediate(this.ledger.db, () => {
      transition(this.ledger, p.id, "merchant", "signed", "expired_unsettled", r.reason);
      transition(this.ledger, p.id, "fulfilment", "not_started", "abandoned");
    });
    markRecoverable(this.ledger, p.id, "the swap did not land; the funded USDC stays in the fresh wallet, recoverable by the owner");
  }
}

/** Owner/agent view of a swap: what it guaranteed, what it expected and where the SOL went. */
export function swapResultView(r: Exclude<SwapResult, { status: "not_ready" | "recovery_required" }>): Record<string, unknown> {
  return {
    kind: "swap",
    dex: "Orca Whirlpools (Solana devnet)",
    whirlpool: DEVNET_SOL_USDC_WHIRLPOOL,
    status: r.status,
    signature: r.signature,
    ...(r.status === "failed"
      ? { reason: r.reason }
      : { minOutLamports: r.minOutLamports.toString(), estOutLamports: r.estOutLamports.toString(), destination: r.destination }),
    linkability: "The swap is paid by a fresh wallet funded from the private pool; the SOL lands publicly at the owner's address.",
  };
}
