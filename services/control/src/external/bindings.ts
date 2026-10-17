import { isAddress } from "@solana/kit";
import { DEMO_TOKEN_MINT, DEVNET_CAIP2, SPONSOR_LAMPORTS_PER_PRIVATE_PURCHASE, isMainnetIdentifier, type FundingBinding } from "@veilo/contracts";
import { immediate } from "@veilo/db";
import { deriveAta, resourcePathMatches } from "@veilo/x402-client";
import { big, num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { writeAudit } from "../ledger/events";

export const EXTERNAL_SERVICE_PREFIX = "x402:";
export const EXTERNAL_BATCH_SKU = "external-x402-batch";
const MAX_BODY_BYTES = 4096;
const RESOURCE_PATH = /^\/[A-Za-z0-9._~/-]{0,200}(\/\*)?$/;

export interface ExternalBindingRow {
  id: string;
  workspace_id: string;
  service_id: string;
  label: string;
  origin: string;
  resource_path: string;
  network: string;
  mint: string;
  pay_to: string;
  pay_to_ata: string;
  unit_price_usdc: bigint;
  max_calls: bigint;
  allowed_fee_payers_json: string;
  allowed_rpc_methods_json: string | null;
  status: "approved" | "disabled";
  scope: "owner" | "workflow";
  approved_by: string;
  created_at_ms: bigint;
  updated_at_ms: bigint;
}

export interface ExternalBindingInput {
  label: string;
  origin: string;
  resourcePath: string;
  network: string;
  mint: string;
  payTo: string;
  payToAta: string;
  unitPriceUsdc: bigint;
  maxCalls: number;
  allowedFeePayers: string[];
  /** For JSON-RPC resources: the only `method` values a call body may name. */
  allowedRpcMethods?: string[] | undefined;
}

export interface ExternalCall {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

export interface ExternalBatchInput {
  bindingId: string;
  calls: ExternalCall[];
}

export interface OriginCheck {
  /** Null when the origin may be paid; local test origins are allowed only by explicit configuration. */
  problem(origin: string): string | null;
}

/**
 * Validates and records an owner-approved external x402 binding. Terms are immutable: a price,
 * recipient, path or fee-payer change needs a new binding. Fails closed on any network or mint
 * other than the pinned devnet pair.
 */
export async function approveExternalBinding(
  ledger: Ledger,
  workspaceId: string,
  ownerId: string,
  input: ExternalBindingInput,
  origins: OriginCheck,
  maxBatchUsdc: bigint,
  scope: "owner" | "workflow" = "owner",
): Promise<ExternalBindingRow> {
  if (input.network !== DEVNET_CAIP2 || isMainnetIdentifier(input.network)) throw new ControlError("WRONG_NETWORK", "external bindings are devnet only");
  if (input.mint !== DEMO_TOKEN_MINT) throw new ControlError("WRONG_MINT", "external bindings must use the pinned devnet mint");
  const originProblem = origins.problem(input.origin) ?? (new URL(input.origin).origin === input.origin ? null : "origin must be a bare origin");
  if (originProblem) throw new ControlError("SERVICE_NOT_ALLOWED", originProblem);
  if (!RESOURCE_PATH.test(input.resourcePath) || input.resourcePath.includes("..")) {
    throw new ControlError("INVALID_REQUEST", "resource path must be an absolute path, optionally ending in /*");
  }
  if (!isAddress(input.payTo) || !isAddress(input.payToAta)) throw new ControlError("INVALID_REQUEST", "recipient addresses must be base58 Solana addresses");
  if ((await deriveAta(input.payTo, input.mint)) !== input.payToAta) {
    throw new ControlError("SERVICE_NOT_ALLOWED", "recipient token account is not the ATA of payTo for the pinned mint");
  }
  if (input.allowedFeePayers.length === 0 || !input.allowedFeePayers.every((a) => isAddress(a))) {
    throw new ControlError("INVALID_REQUEST", "at least one valid facilitator fee payer is required");
  }
  if (!Number.isInteger(input.maxCalls) || input.maxCalls < 1 || input.maxCalls > 100) throw new ControlError("INVALID_REQUEST", "max calls must be 1-100");
  if (input.unitPriceUsdc <= 0n) throw new ControlError("INVALID_REQUEST", "unit price must be positive");
  const batch = input.unitPriceUsdc * BigInt(input.maxCalls);
  if (batch > maxBatchUsdc) throw new ControlError("BUDGET_EXCEEDED", "unit price × max calls exceeds the external batch ceiling");
  if (input.allowedRpcMethods !== undefined && !input.allowedRpcMethods.every((m) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(m))) {
    throw new ControlError("INVALID_REQUEST", "invalid RPC method name");
  }

  return immediate(ledger.db, () => {
    const now = ledger.now();
    const ws = ledger.db.prepare(`SELECT network, mint FROM workspace WHERE id = ?`).get(workspaceId) as { network: string; mint: string } | undefined;
    if (!ws) throw new ControlError("NOT_FOUND", "workspace not found");
    if (ws.network !== input.network || ws.mint !== input.mint) throw new ControlError("WRONG_NETWORK", "binding differs from the workspace network or mint");
    const id = ledger.newId();
    const serviceId = ledger.newId();
    ledger.db
      .prepare(
        `INSERT INTO approved_service (id, workspace_id, service_key, origin, gateway_identity, recipient, recipient_ata, network, mint,
           status, description, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
      )
      .run(serviceId, workspaceId, `${EXTERNAL_SERVICE_PREFIX}${id}`, input.origin, `external:${new URL(input.origin).host}`, input.payTo, input.payToAta,
        input.network, input.mint, input.label, now, now);
    ledger.db
      .prepare(
        `INSERT INTO service_sku (id, service_id, sku, payment_path, price_usdc, max_fee_usdc, usage_units, sponsor_lamports)
         VALUES (?, ?, ?, 'private_x402', ?, 0, 0, ?)`,
      )
      .run(ledger.newId(), serviceId, EXTERNAL_BATCH_SKU, batch, SPONSOR_LAMPORTS_PER_PRIVATE_PURCHASE);
    ledger.db
      .prepare(
        `INSERT INTO external_binding (id, workspace_id, service_id, label, origin, resource_path, network, mint, pay_to, pay_to_ata,
           unit_price_usdc, max_calls, allowed_fee_payers_json, allowed_rpc_methods_json, status, scope, approved_by, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)`,
      )
      .run(id, workspaceId, serviceId, input.label, input.origin, input.resourcePath, input.network, input.mint, input.payTo, input.payToAta,
        input.unitPriceUsdc, input.maxCalls, JSON.stringify(input.allowedFeePayers),
        input.allowedRpcMethods === undefined ? null : JSON.stringify(input.allowedRpcMethods), scope, ownerId, now, now);
    writeAudit(ledger, {
      workspaceId,
      scope: `external:${id}`,
      actorType: "owner",
      actorId: ownerId,
      action: "external_binding.approve",
      policyResult: "allowed",
      details: { origin: input.origin, resourcePath: input.resourcePath, payTo: input.payTo, unitPriceUsdc: input.unitPriceUsdc, maxCalls: input.maxCalls },
    });
    return getExternalBinding(ledger, id) as ExternalBindingRow;
  });
}

export function disableExternalBinding(ledger: Ledger, workspaceId: string, ownerId: string, id: string): ExternalBindingRow {
  return immediate(ledger.db, () => {
    const b = getExternalBinding(ledger, id);
    if (!b || b.workspace_id !== workspaceId) throw new ControlError("NOT_FOUND", "external binding not found");
    if (b.status === "disabled") return b;
    const now = ledger.now();
    ledger.db.prepare(`UPDATE external_binding SET status = 'disabled', updated_at_ms = ? WHERE id = ?`).run(now, id);
    ledger.db.prepare(`UPDATE approved_service SET status = 'disabled', updated_at_ms = ? WHERE id = ?`).run(now, b.service_id);
    writeAudit(ledger, { workspaceId, scope: `external:${id}`, actorType: "owner", actorId: ownerId, action: "external_binding.disable", policyResult: "allowed" });
    return getExternalBinding(ledger, id) as ExternalBindingRow;
  });
}

export function getExternalBinding(ledger: Ledger, id: string): ExternalBindingRow | undefined {
  return ledger.db.prepare(`SELECT * FROM external_binding WHERE id = ?`).get(id) as ExternalBindingRow | undefined;
}

export function externalBindingForService(ledger: Ledger, serviceId: string): ExternalBindingRow | undefined {
  return ledger.db.prepare(`SELECT * FROM external_binding WHERE service_id = ?`).get(serviceId) as ExternalBindingRow | undefined;
}

export function listExternalBindings(ledger: Ledger, workspaceId: string): ExternalBindingRow[] {
  return ledger.db.prepare(`SELECT * FROM external_binding WHERE workspace_id = ? ORDER BY created_at_ms`).all(workspaceId) as ExternalBindingRow[];
}

/** The funding binding the wallet stores at prepare time and deep-compares before each call. */
export function externalFundingBinding(b: ExternalBindingRow, sku: string): FundingBinding {
  return {
    origin: b.origin,
    gatewayIdentity: "",
    sku,
    network: b.network,
    mint: b.mint,
    payTo: b.pay_to,
    merchantAta: b.pay_to_ata,
    allowedFeePayers: JSON.parse(b.allowed_fee_payers_json) as string[],
    external: { resourcePath: b.resource_path, unitUsdc: big(b.unit_price_usdc).toString(), maxCalls: num(b.max_calls) },
  };
}

/**
 * Validates a batch input against its binding before it is stored. Bodies are data sent to the
 * approved resource; they never become instructions to an agent.
 */
export function externalInputProblem(b: ExternalBindingRow, input: unknown): string | null {
  const v = input as Partial<ExternalBatchInput> | null;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "input must be an object";
  const keys = Object.keys(v);
  if (keys.some((k) => k !== "bindingId" && k !== "calls")) return "input has unknown fields";
  if (v.bindingId !== b.id) return "input names a different binding";
  if (!Array.isArray(v.calls) || v.calls.length === 0) return "at least one call is required";
  if (v.calls.length > num(b.max_calls)) return "more calls than the binding allows";
  const methods = b.allowed_rpc_methods_json === null ? null : (JSON.parse(b.allowed_rpc_methods_json) as string[]);
  for (const [i, c] of v.calls.entries()) {
    if (typeof c !== "object" || c === null || Object.keys(c).some((k) => !["method", "path", "body"].includes(k))) return `call ${i} is malformed`;
    if (c.method !== "GET" && c.method !== "POST") return `call ${i} method must be GET or POST`;
    if (typeof c.path !== "string" || !resourcePathMatches(b.resource_path, c.path)) return `call ${i} path is outside the approved resource`;
    const url = new URL(c.path, b.origin);
    if (url.origin !== b.origin || url.pathname !== c.path || url.search !== "" || url.hash !== "") return `call ${i} path does not resolve to itself`;
    if (c.method === "GET" && c.body !== undefined) return `call ${i} GET cannot carry a body`;
    if (c.body !== undefined && Buffer.byteLength(JSON.stringify(c.body)) > MAX_BODY_BYTES) return `call ${i} body exceeds ${MAX_BODY_BYTES} bytes`;
    if (methods !== null) {
      const rpc = (c.body as { method?: unknown } | undefined)?.method;
      if (Array.isArray(c.body) || typeof rpc !== "string" || !methods.includes(rpc)) return `call ${i} RPC method is not allowed by the binding`;
    }
  }
  return null;
}
