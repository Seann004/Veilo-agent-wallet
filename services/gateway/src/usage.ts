import { randomUUID } from "node:crypto";
import {
  computeRequestDigest,
  GATEWAY_CATALOG,
  GATEWAY_CREDIT_LABEL,
  isInferenceSku,
  skuInputSchemas,
  usageAuthorizeRequestSchema,
  usageExecuteRequestSchema,
  usageReleaseRequestSchema,
  UsagePermitError,
  verifyUsagePermit,
  type GatewaySku,
} from "@veilo/contracts/gateway";
import type { AccountRow } from "./auth";
import type { GatewayContext } from "./context";
import { immediate } from "./db/database";
import { GatewayError } from "./errors";
import { appendCreditEvent, balanceView } from "./ledger/credits";
import type { KeyedLock } from "./locks";
import type { InferenceOutcome } from "./inference";
import { inferenceResult, type HttpResult } from "./purchases";
import { buildMessages } from "./skus/prompts";

type UsageState = "reserved" | "dispatched" | "completed" | "incomplete" | "uncertain" | "released";

interface UsageRow {
  id: string;
  account_id: string;
  operation_id: string;
  permit_nonce: string;
  sku: GatewaySku;
  units: bigint;
  request_digest: string;
  scope: string;
  agent_ref: string | null;
  task_ref: string | null;
  permit_expires_at: string;
  state: UsageState;
  input_json: string | null;
  result_json: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export class UsageService {
  constructor(
    private readonly ctx: GatewayContext,
    private readonly lock: KeyedLock,
  ) {}

  private byOperation(accountId: string, operationId: string): UsageRow | undefined {
    return this.ctx.db
      .prepare("SELECT * FROM usage_operations WHERE account_id = ? AND operation_id = ?")
      .get(accountId, operationId) as UsageRow | undefined;
  }

  private byId(id: string): UsageRow {
    return this.ctx.db.prepare("SELECT * FROM usage_operations WHERE id = ?").get(id) as UsageRow;
  }

  view(row: UsageRow) {
    return {
      reservationId: row.id,
      operationId: row.operation_id,
      accountId: row.account_id,
      sku: row.sku,
      paymentPath: "prepaid" as const,
      units: row.units.toString(),
      unit: "gateway_microcredits" as const,
      requestDigest: row.request_digest,
      state: row.state,
      permitExpiresAt: row.permit_expires_at,
      attribution: { agentRef: row.agent_ref, taskRef: row.task_ref },
      result: row.result_json ? (JSON.parse(row.result_json) as unknown) : null,
      error: row.error_code ? { code: row.error_code } : null,
      onChainCharge: "none",
      note: "Credits purchased; no extra on-chain charge for this call.",
      label: GATEWAY_CREDIT_LABEL,
      balance: balanceView(this.ctx.db, row.account_id, this.ctx.now()),
    };
  }

  /**
   * Reserves the SKU's fixed units for one permitted operation. Replaying the same permit or
   * re-authorizing the same operation returns the original reservation; nothing is reserved twice.
   */
  authorize(account: AccountRow, body: unknown): HttpResult {
    const parsed = usageAuthorizeRequestSchema.safeParse(body);
    if (!parsed.success) throw new GatewayError(400, "BAD_REQUEST", "Invalid usage authorization request");
    if (!this.ctx.permitPublicKey) {
      throw new GatewayError(503, "PROVIDER_UNAVAILABLE", "Usage permits are not configured on this gateway");
    }
    let permit;
    try {
      permit = verifyUsagePermit(parsed.data.permit, {
        publicKey: this.ctx.permitPublicKey,
        audience: this.ctx.settings.identity,
        nowSeconds: Math.floor(this.ctx.now().getTime() / 1000),
      });
    } catch (error) {
      if (error instanceof UsagePermitError) {
        throw new GatewayError(error.reason === "bad_signature" ? 401 : 403, "POLICY_DENIED", `Usage permit rejected: ${error.reason}`);
      }
      throw error;
    }
    if (permit.accountId !== account.id) {
      throw new GatewayError(403, "POLICY_DENIED", "Usage permit is bound to a different account");
    }
    const def = GATEWAY_CATALOG[permit.sku];
    if (def.prepaidUnits === null || !isInferenceSku(permit.sku)) {
      throw new GatewayError(400, "SERVICE_NOT_ALLOWED", "SKU is not available for prepaid usage");
    }
    const units = BigInt(permit.units);
    if (units !== def.prepaidUnits) throw new GatewayError(409, "PRICE_CHANGED", "Permit units differ from the SKU's fixed charge");

    const replay = this.ctx.db.prepare("SELECT * FROM usage_operations WHERE permit_nonce = ?").get(permit.nonce) as UsageRow | undefined;
    const sameOperation = (row: UsageRow) =>
      row.account_id === account.id &&
      row.operation_id === permit.operationId &&
      row.sku === permit.sku &&
      row.units === units &&
      row.request_digest === permit.requestDigest;
    if (replay) {
      if (!sameOperation(replay)) throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Usage permit nonce already used");
      return { status: 200, body: this.view(replay) };
    }
    const existing = this.byOperation(account.id, permit.operationId);
    if (existing) {
      if (!sameOperation(existing)) throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Operation already authorized with a different request");
      return { status: 200, body: this.view(existing) };
    }
    if (account.status !== "active") throw new GatewayError(403, "ACCOUNT_STOPPED", "Gateway account is stopped");
    const ready = this.ctx.inference.readiness("inference");
    if (!ready.ready) throw new GatewayError(503, ready.code, `Inference unavailable: ${ready.reason}`);

    const id = `rsv_${randomUUID()}`;
    const now = this.ctx.now();
    immediate(this.ctx.db, () => {
      if (this.ctx.db.prepare("SELECT 1 FROM usage_operations WHERE permit_nonce = ? OR (account_id = ? AND operation_id = ?)").get(permit.nonce, account.id, permit.operationId)) {
        throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Concurrent authorization for this operation");
      }
      const c = this.ctx.db.prepare("SELECT issued, reserved, consumed FROM accounts WHERE id = ?").get(account.id) as {
        issued: bigint;
        reserved: bigint;
        consumed: bigint;
      };
      if (c.issued - c.consumed - c.reserved < units) {
        throw new GatewayError(409, "BUDGET_EXCEEDED", "Insufficient gateway credits for this SKU");
      }
      this.ctx.db
        .prepare(
          `INSERT INTO usage_operations (id, account_id, operation_id, permit_nonce, sku, units, request_digest, scope, agent_ref, task_ref,
             permit_expires_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
        )
        .run(
          id,
          account.id,
          permit.operationId,
          permit.nonce,
          permit.sku,
          units,
          permit.requestDigest,
          permit.scope,
          permit.agentRef ?? null,
          permit.taskRef ?? null,
          new Date(permit.exp * 1000).toISOString(),
          now.toISOString(),
          now.toISOString(),
        );
      appendCreditEvent(this.ctx.db, { accountId: account.id, kind: "reserve", units, reservationId: id, at: now });
    });
    return { status: 201, body: this.view(this.byId(id)) };
  }

  /** Releases an undispatched reservation once; dispatched or ambiguous usage cannot be released. */
  private release(row: UsageRow, reason: string): void {
    const now = this.ctx.now();
    immediate(this.ctx.db, () => {
      const current = this.byId(row.id);
      if (current.state === "released") return;
      if (current.state !== "reserved" && current.state !== "dispatched") {
        throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Usage already resolved");
      }
      this.ctx.db
        .prepare("UPDATE usage_operations SET state = 'released', error_code = ?, updated_at = ? WHERE id = ?")
        .run(reason, now.toISOString(), row.id);
      appendCreditEvent(this.ctx.db, { accountId: row.account_id, kind: "release", units: row.units, reservationId: row.id, at: now });
    });
  }

  private permitExpired(row: UsageRow): boolean {
    return this.ctx.now().getTime() >= Date.parse(row.permit_expires_at);
  }

  async execute(account: AccountRow, body: unknown): Promise<HttpResult> {
    const parsed = usageExecuteRequestSchema.safeParse(body);
    if (!parsed.success) throw new GatewayError(400, "BAD_REQUEST", "Invalid usage execute request");
    const row = this.byOperation(account.id, parsed.data.operationId);
    if (!row) throw new GatewayError(404, "NOT_FOUND", "No authorized usage for this operation");
    if (row.id !== parsed.data.reservationId) {
      throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Reservation does not belong to this operation");
    }
    const input = skuInputSchemas[row.sku].safeParse(parsed.data.input);
    if (!input.success || computeRequestDigest(row.sku, input.data) !== row.request_digest) {
      throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Input does not match the permitted request digest");
    }
    return this.lock.run(`usage:${row.id}`, () => this.#execute(row.id, input.data as Record<string, unknown>));
  }

  async #execute(id: string, input: Record<string, unknown>): Promise<HttpResult> {
    const row = this.byId(id);
    switch (row.state) {
      case "completed":
      case "incomplete":
      case "uncertain":
        return { status: 200, body: this.view(row) };
      case "released":
        throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Reservation was released; obtain a new permit");
      case "dispatched":
        // Only reachable after a crash between dispatch and outcome; recovery resolves it.
        await this.recoverRow(row);
        return { status: 200, body: this.view(this.byId(id)) };
      case "reserved":
        break;
    }
    if (this.permitExpired(row)) {
      this.release(row, "PERMIT_EXPIRED");
      throw new GatewayError(403, "POLICY_DENIED", "Usage permit expired before dispatch; reservation released");
    }
    const dispatched = this.ctx.db
      .prepare("UPDATE usage_operations SET state = 'dispatched', input_json = ?, updated_at = ? WHERE id = ? AND state = 'reserved'")
      .run(JSON.stringify(input), this.ctx.now().toISOString(), id);
    if (dispatched.changes !== 1) return { status: 200, body: this.view(this.byId(id)) };

    const sku = row.sku;
    if (!isInferenceSku(sku)) throw new Error("prepaid usage is limited to inference SKUs");
    const def = GATEWAY_CATALOG[sku];
    const outcome = await this.ctx.inference.run({
      sourceKind: "usage",
      sourceId: id,
      purpose: "prepaid",
      role: "inference",
      messages: buildMessages(sku, input),
      maxInputTokens: def.maxInputTokens as number,
      maxOutputTokens: def.maxOutputTokens as number,
      jsonObject: sku === "content-package",
    });
    this.applyOutcome(this.byId(id), outcome, input);
    const final = this.byId(id);
    const status = final.state === "released" ? (outcome.status === "rejected" && outcome.code === "INPUT_TOO_LONG" ? 413 : 503) : 200;
    return { status, body: this.view(final) };
  }

  private applyOutcome(row: UsageRow, outcome: InferenceOutcome, input: Record<string, unknown>): void {
    const now = this.ctx.now();
    switch (outcome.status) {
      case "rejected":
        this.release(row, outcome.code);
        return;
      case "failed":
        this.release(row, "PROVIDER_UNAVAILABLE");
        return;
      case "uncertain":
        // The reservation stays held until the operator reconciles the provider outcome.
        this.ctx.db
          .prepare("UPDATE usage_operations SET state = 'uncertain', error_code = 'PAID_NO_RESULT', updated_at = ? WHERE id = ? AND state = 'dispatched'")
          .run(now.toISOString(), row.id);
        return;
      case "succeeded": {
        const r = inferenceResult(outcome, row.sku, input);
        immediate(this.ctx.db, () => {
          const changed = this.ctx.db
            .prepare("UPDATE usage_operations SET state = ?, result_json = ?, updated_at = ? WHERE id = ? AND state = 'dispatched'")
            .run(r.valid ? "completed" : "incomplete", JSON.stringify(r.result), now.toISOString(), row.id);
          if (changed.changes === 1) {
            appendCreditEvent(this.ctx.db, { accountId: row.account_id, kind: "consume", units: row.units, reservationId: row.id, at: now });
          }
        });
        return;
      }
    }
  }

  get(account: AccountRow, operationId: string): HttpResult {
    const row = this.byOperation(account.id, operationId);
    if (!row) throw new GatewayError(404, "NOT_FOUND", "No usage for this operation");
    if (row.state === "reserved" && this.permitExpired(row)) this.release(row, "PERMIT_EXPIRED");
    return { status: 200, body: this.view(this.byId(row.id)) };
  }

  releaseRequest(account: AccountRow, operationId: string, body: unknown): HttpResult {
    const parsed = usageReleaseRequestSchema.safeParse(body);
    if (!parsed.success) throw new GatewayError(400, "BAD_REQUEST", "Invalid release request");
    const row = this.byOperation(account.id, operationId);
    if (!row || row.id !== parsed.data.reservationId) throw new GatewayError(404, "NOT_FOUND", "No such reservation");
    if (row.state !== "reserved" && row.state !== "released") {
      throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", `Reservation is ${row.state}; it can no longer be released`);
    }
    this.release(row, "RELEASED_BY_CONTROL");
    return { status: 200, body: this.view(this.byId(row.id)) };
  }

  private async recoverRow(row: UsageRow): Promise<void> {
    const outcome = this.ctx.inference.existing("usage", row.id);
    if (!outcome) {
      // Dispatch was recorded but no execution row exists: the provider was never called.
      this.release(row, "INTERRUPTED_BEFORE_DISPATCH");
      return;
    }
    this.applyOutcome(row, outcome, JSON.parse(row.input_json ?? "{}") as Record<string, unknown>);
  }

  /** Startup: resolve dispatched rows from execution records and release expired, undispatched ones. */
  async recover(): Promise<void> {
    const rows = this.ctx.db.prepare("SELECT * FROM usage_operations WHERE state IN ('reserved', 'dispatched')").all() as UsageRow[];
    for (const row of rows) {
      await this.lock.run(`usage:${row.id}`, async () => {
        const current = this.byId(row.id);
        if (current.state === "dispatched") await this.recoverRow(current);
        else if (current.state === "reserved" && this.permitExpired(current)) this.release(current, "PERMIT_EXPIRED");
      });
    }
  }
}
