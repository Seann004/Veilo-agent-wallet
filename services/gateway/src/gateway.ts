import type { KeyObject } from "node:crypto";
import { GATEWAY_CATALOG, GATEWAY_CREDIT_LABEL } from "@veilo/contracts/gateway";
import { healthReport, type ServiceHealth } from "@veilo/contracts";
import { checkFacilitatorSupport, deriveAta } from "@veilo/x402-client";
import type { GatewayChain } from "./chain";
import type { GatewayContext, GatewayFacilitator, GatewayHooks, GatewaySettings } from "./context";
import { schemaVersion, type GatewayDb } from "./db/database";
import { InferenceService } from "./inference";
import { operatorBudgetView } from "./ledger/operator";
import { KeyedLock } from "./locks";
import { PlanningService } from "./planning";
import { pinnedModel, type PinnedModel } from "./provider/pinned-models";
import { PricingGuard } from "./provider/pricing";
import type { ChatProvider, FetchLike } from "./provider/types";
import { PurchaseService } from "./purchases";
import { UsageService } from "./usage";

export interface GatewayOptions {
  db: GatewayDb;
  settings: GatewaySettings;
  chain: GatewayChain;
  facilitator: GatewayFacilitator;
  provider: ChatProvider | null;
  providerDisabledReason?: string | undefined;
  inferenceModelId: string | undefined;
  plannerModelId: string | undefined;
  pricingFetch?: FetchLike;
  pricingMaxAgeSeconds: number;
  providerTimeoutMs: number;
  permitPublicKey?: KeyObject;
  planningTokenHash?: string;
  /** Optional provider key spend-limit probe (no generation). Returns remaining micro-USD or null if unlimited. */
  providerKeyCheck?: () => Promise<bigint | null>;
  serviceHealth: ServiceHealth;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  hooks?: GatewayHooks;
}

export class Gateway {
  readonly ctx: GatewayContext;
  readonly purchases: PurchaseService;
  readonly usage: UsageService;
  readonly planning: PlanningService;
  readonly pricing: PricingGuard;
  readonly #options: GatewayOptions;
  readonly #models: { inference: PinnedModel | undefined; planner: PinnedModel | undefined };
  #keyCheck: { ok: boolean; detail: string; checkedAt: string } | undefined;

  constructor(options: GatewayOptions) {
    this.#options = options;
    const now = options.now ?? (() => new Date());
    this.pricing = new PricingGuard(options.db, options.pricingMaxAgeSeconds, options.pricingFetch);
    this.#models = { inference: pinnedModel(options.inferenceModelId), planner: pinnedModel(options.plannerModelId) };
    let disabledReason = options.providerDisabledReason;
    if (options.provider && options.settings.operatorCeilingMicro <= 0n) disabledReason = "OPERATOR_MAX_REAL_USD_MICRO is zero";
    const provider = options.settings.operatorCeilingMicro > 0n ? options.provider : null;
    const hooks = options.hooks ?? {};
    const inference = new InferenceService({
      db: options.db,
      provider,
      providerDisabledReason: disabledReason,
      pricing: this.pricing,
      models: this.#models,
      ceilingMicro: options.settings.operatorCeilingMicro,
      timeoutMs: options.providerTimeoutMs,
      now,
      hooks: { beforeProviderCall: () => hooks.beforeProviderCall?.() },
    });
    this.ctx = {
      db: options.db,
      settings: options.settings,
      chain: options.chain,
      facilitator: options.facilitator,
      inference,
      permitPublicKey: options.permitPublicKey,
      planningTokenHash: options.planningTokenHash,
      acceptance: { ready: false, reason: "facilitator support not checked yet", support: undefined, merchantAta: undefined, feePayer: undefined },
      now,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      hooks,
    };
    const lock = new KeyedLock();
    this.purchases = new PurchaseService(this.ctx, lock);
    this.usage = new UsageService(this.ctx, lock);
    this.planning = new PlanningService(this.ctx);
  }

  /** Verifies recipient configuration and facilitator capability; fails closed on any gap. */
  async refreshAcceptance(): Promise<void> {
    const s = this.ctx.settings;
    const fail = (reason: string, extra: Partial<GatewayContext["acceptance"]> = {}) => {
      this.ctx.acceptance = { ready: false, reason, support: undefined, merchantAta: undefined, feePayer: undefined, ...extra };
    };
    if (!s.merchantAddress) return fail("merchant address not configured");
    if (!s.feePayer) return fail("facilitator fee payer not configured");
    const derived = await deriveAta(s.merchantAddress, s.mint);
    if (s.merchantAta !== undefined && s.merchantAta !== derived) return fail("configured merchant ATA is not the derived ATA");
    let support;
    try {
      support = checkFacilitatorSupport(await this.ctx.facilitator.getSupported(), {
        network: s.network,
        mint: s.mint,
        feePayer: s.feePayer,
      });
    } catch (error) {
      return fail(`facilitator /supported unavailable: ${(error as Error).name}`);
    }
    if (!support.supported) return fail(support.reason, { support });
    this.ctx.acceptance = { ready: true, reason: undefined, support, merchantAta: derived, feePayer: s.feePayer };
  }

  async refreshPricing(): Promise<void> {
    const models = [this.#models.inference, this.#models.planner].filter((m): m is PinnedModel => m !== undefined);
    const unique = [...new Map(models.map((m) => [m.id, m])).values()];
    if (unique.length > 0 && this.ctx.inference.mode !== "disabled") await this.pricing.refresh(unique, this.ctx.now());
  }

  async refreshProviderKey(): Promise<void> {
    if (!this.#options.providerKeyCheck || this.ctx.inference.mode !== "live") return;
    const checkedAt = this.ctx.now().toISOString();
    try {
      const remaining = await this.#options.providerKeyCheck();
      const ok = remaining === null || remaining > 0n;
      this.#keyCheck = { ok, detail: remaining === null ? "key has no spend limit" : `key limit remaining ${remaining} micro-USD`, checkedAt };
    } catch (error) {
      this.#keyCheck = { ok: false, detail: `key check failed: ${(error as Error).message}`, checkedAt };
    }
  }

  async refreshExternal(): Promise<void> {
    await Promise.all([this.refreshAcceptance(), this.refreshPricing(), this.refreshProviderKey()]);
  }

  /** Startup reconciliation, before serving new work. */
  async recover(): Promise<void> {
    this.ctx.inference.markInterruptedUncertain();
    await this.purchases.recover();
    await this.usage.recover();
  }

  health() {
    let database: { ok: boolean; schemaVersion?: number; error?: string };
    try {
      this.ctx.db.prepare("SELECT 1").get();
      database = { ok: true, schemaVersion: schemaVersion(this.ctx.db) };
    } catch (error) {
      database = { ok: false, error: (error as Error).message };
    }
    const base = healthReport(this.#options.serviceHealth);
    const inferenceReady = this.ctx.inference.readiness("inference");
    const plannerReady = this.ctx.inference.readiness("planner");
    const budget = operatorBudgetView(this.ctx.db, this.ctx.settings.operatorCeilingMicro);
    const keyOk = this.#keyCheck === undefined || this.#keyCheck.ok;
    const a = this.ctx.acceptance;
    const ok = base.status === "ok" && database.ok;
    return {
      ...base,
      status: ok ? "ok" : "unavailable",
      database,
      x402: {
        accepting: a.ready && ok,
        reason: a.reason ?? null,
        facilitatorUrl: this.ctx.settings.facilitatorUrl,
        facilitator: a.support ?? null,
        merchantAddress: this.ctx.settings.merchantAddress ?? null,
        merchantAta: a.merchantAta ?? null,
        feePayer: a.feePayer ?? null,
      },
      provider: {
        mode: this.ctx.inference.mode,
        inference: { model: this.#models.inference?.id ?? null, ...inferenceReady },
        planner: { model: this.#models.planner?.id ?? null, ...plannerReady },
        operatorBudget: budget,
        keyCheck: this.#keyCheck ?? null,
        ready: inferenceReady.ready && keyOk && BigInt(budget.remainingMicro) > 0n,
      },
      catalog: Object.values(GATEWAY_CATALOG).map((d) => ({
        sku: d.sku,
        x402Amount: d.x402Amount?.toString() ?? null,
        prepaidUnits: d.prepaidUnits?.toString() ?? null,
      })),
      labels: { credits: GATEWAY_CREDIT_LABEL },
    };
  }
}
