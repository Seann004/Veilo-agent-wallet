import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { DEMO_TOKEN_MINT, DEVNET_CAIP2, isMainnetIdentifier } from "@veilo/contracts";
import { deriveAta } from "./ata";
import { X402ClientError } from "./errors";

/**
 * Owner-approved service binding. A payment requirement is acceptable only if every field
 * matches; redirects or new recipients need a new binding.
 */
export interface ApprovedServiceBinding {
  /** Exact origin (scheme://host[:port]) of the protected resource. */
  origin: string;
  /** Exact resource URL when known (for example a quote's execute URL). */
  resourceUrl?: string;
  /**
   * Approved resource path: an exact path, or a prefix ending in `/*` that matches deeper
   * segments only. Query strings are ignored; the origin is checked separately.
   */
  resourcePath?: string;
  /** Gateway identity that must appear as `resource.serviceName`, when the service declares one. */
  gatewayIdentity?: string;
  /** Approved product SKU; when set, `resource.tags` must contain `veilo-sku:<sku>`. */
  sku?: string;
  network: string;
  mint: string;
  /** Merchant owner address (`payTo`). */
  payTo: string;
  /** Recipient ATA; must equal the ATA derived from payTo and mint. */
  merchantAta: string;
  /** Hard per-payment ceiling in base units. */
  maxAmount: bigint;
  /** Exact quoted charge, when the caller holds an immutable quote. */
  exactAmount?: bigint;
  /** Facilitator fee payers permitted to sponsor the transaction. */
  allowedFeePayers: readonly string[];
  maxTimeoutSeconds?: number;
}

export interface VerifiedRequirement {
  requirements: PaymentRequirements;
  amount: bigint;
  feePayer: string;
  recentBlockhash: string | undefined;
}

const DEFAULT_MAX_TIMEOUT_SECONDS = 600;

export async function assertBindingConsistent(binding: ApprovedServiceBinding): Promise<void> {
  if (binding.network !== DEVNET_CAIP2 || isMainnetIdentifier(binding.network)) {
    throw new X402ClientError("WRONG_NETWORK", "binding_network_not_devnet");
  }
  if (binding.mint !== DEMO_TOKEN_MINT) throw new X402ClientError("WRONG_MINT", "binding_mint_not_pinned");
  if ((await deriveAta(binding.payTo, binding.mint)) !== binding.merchantAta) {
    throw new X402ClientError("SERVICE_NOT_ALLOWED", "binding_ata_not_derived_from_pay_to");
  }
  if (binding.maxAmount <= 0n) throw new X402ClientError("POLICY_DENIED", "binding_max_amount_not_positive");
  if (binding.allowedFeePayers.length === 0) throw new X402ClientError("POLICY_DENIED", "binding_without_fee_payer");
}

/**
 * Selects the single requirement that satisfies the approved binding. Throws before any
 * signing work when the challenge does not match exactly.
 */
export async function verifyPaymentRequired(
  paymentRequired: PaymentRequired,
  binding: ApprovedServiceBinding,
): Promise<VerifiedRequirement> {
  await assertBindingConsistent(binding);
  if (paymentRequired.x402Version !== 2) throw new X402ClientError("SERVICE_NOT_ALLOWED", "x402_version_not_2");

  let resourceUrl: URL;
  try {
    resourceUrl = new URL(paymentRequired.resource.url);
  } catch {
    throw new X402ClientError("SERVICE_NOT_ALLOWED", "resource_url_invalid");
  }
  if (resourceUrl.origin !== new URL(binding.origin).origin) {
    throw new X402ClientError("SERVICE_NOT_ALLOWED", "resource_origin_mismatch");
  }
  if (binding.resourceUrl !== undefined && paymentRequired.resource.url !== binding.resourceUrl) {
    throw new X402ClientError("SERVICE_NOT_ALLOWED", "resource_url_mismatch");
  }
  if (binding.resourcePath !== undefined && !resourcePathMatches(binding.resourcePath, resourceUrl.pathname)) {
    throw new X402ClientError("SERVICE_NOT_ALLOWED", "resource_path_mismatch");
  }
  if (binding.gatewayIdentity !== undefined && paymentRequired.resource.serviceName !== binding.gatewayIdentity) {
    throw new X402ClientError("SERVICE_NOT_ALLOWED", "gateway_identity_mismatch");
  }
  if (binding.sku !== undefined && !(paymentRequired.resource.tags ?? []).includes(`veilo-sku:${binding.sku}`)) {
    throw new X402ClientError("SERVICE_NOT_ALLOWED", "sku_mismatch");
  }

  let candidates = paymentRequired.accepts.filter(
    (r) => r.scheme === "exact" && r.network === binding.network && r.asset === binding.mint && r.payTo === binding.payTo,
  );
  // Some services list several prices for one recipient (for example a per-request charge and a
  // prepaid top-up). Only a pinned exact amount may choose between them.
  if (candidates.length > 1 && binding.exactAmount !== undefined) {
    const exact = binding.exactAmount.toString();
    candidates = candidates.filter((r) => r.amount === exact);
    if (candidates.length === 0) throw new X402ClientError("PRICE_CHANGED", "no_requirement_at_approved_price");
  }
  if (candidates.length === 0) {
    const anyDevnet = paymentRequired.accepts.some((r) => r.network === DEVNET_CAIP2);
    const anyMint = paymentRequired.accepts.some((r) => r.asset === binding.mint);
    if (!anyDevnet) throw new X402ClientError("WRONG_NETWORK", "no_devnet_exact_requirement");
    if (!anyMint) throw new X402ClientError("WRONG_MINT", "no_requirement_for_pinned_mint");
    throw new X402ClientError("SERVICE_NOT_ALLOWED", "no_requirement_for_approved_recipient");
  }
  if (candidates.length > 1) throw new X402ClientError("SERVICE_NOT_ALLOWED", "ambiguous_requirements");
  const requirements = candidates[0] as PaymentRequirements;

  if (!/^(0|[1-9][0-9]*)$/.test(requirements.amount)) throw new X402ClientError("POLICY_DENIED", "amount_not_integer");
  const amount = BigInt(requirements.amount);
  if (amount <= 0n) throw new X402ClientError("POLICY_DENIED", "amount_not_positive");
  if (amount > binding.maxAmount) throw new X402ClientError("PRICE_CHANGED", "amount_exceeds_ceiling");
  if (binding.exactAmount !== undefined && amount !== binding.exactAmount) {
    throw new X402ClientError("PRICE_CHANGED", "amount_differs_from_quote");
  }
  const maxTimeout = binding.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  if (!Number.isInteger(requirements.maxTimeoutSeconds) || requirements.maxTimeoutSeconds <= 0 || requirements.maxTimeoutSeconds > maxTimeout) {
    throw new X402ClientError("POLICY_DENIED", "max_timeout_out_of_bounds");
  }
  const extra = requirements.extra ?? {};
  const feePayer = extra.feePayer;
  if (typeof feePayer !== "string" || !binding.allowedFeePayers.includes(feePayer)) {
    throw new X402ClientError("SERVICE_NOT_ALLOWED", "fee_payer_not_allowed");
  }
  // A seller memo is published on chain; refuse it so no account or quote identifier leaks there.
  if (extra.memo !== undefined) throw new X402ClientError("POLICY_DENIED", "seller_memo_not_allowed");
  if (extra.paymentFlow !== undefined && extra.paymentFlow !== "authorization" && extra.paymentFlow !== "upfront") {
    throw new X402ClientError("POLICY_DENIED", "payment_flow_not_allowed");
  }
  const recentBlockhash = typeof extra.recentBlockhash === "string" ? extra.recentBlockhash : undefined;
  return { requirements, amount, feePayer, recentBlockhash };
}

/** Matches an approved resource path: exact, or a `/*` prefix that requires a deeper segment. */
export function resourcePathMatches(pattern: string, pathname: string): boolean {
  if (!pattern.startsWith("/") || pattern.includes("?") || pattern.includes("#")) return false;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return pathname.startsWith(prefix) && pathname.length > prefix.length && !pathname.includes("/../");
  }
  return pathname === pattern;
}
