import { createHash, randomUUID } from "node:crypto";
import { GATEWAY_CATALOG } from "@veilo/contracts/gateway";
import {
  completeRequestSchema,
  computeInputDigest,
  leaseGrantSchema,
  resultEnvelopeSchema,
  sellerHostJobViewSchema,
  verifyQuote,
  type ManagedTemplate,
  type MarketplaceQuote,
  type SellerHostJobView,
  type SpecialistJobInput,
} from "@veilo/contracts/marketplace";
import { deriveAta } from "@veilo/x402-client";
import type { GatewayContext } from "../context";
import { immediate } from "../db/database";
import { GatewayError, type GatewayErrorCode } from "../errors";
import { provenanceOf, type InferenceOutcome } from "../inference";
import { conservativeInputTokens } from "../provider/token-bound";
import { MarketplaceUnavailableError, type MarketplaceClient, type MarketplaceResponse } from "./marketplace-client";
import { buildTemplateMessages, missingSections, summarize } from "./templates";

const SPECIALIST = GATEWAY_CATALOG["specialist-job"];
const MAX_ROUNDS = 8;

export type SellerRuntime = SellerHostJobView["runtime"];

/** Payment terms for one gateway quote, all taken from one verified marketplace quote. */
export interface SpecialistQuoteTerms {
  amount: bigint;
  payTo: string;
  merchantAta: string;
  expiresAt: Date;
  maxInputTokens: number;
  maxOutputTokens: number;
  marketplaceQuote: MarketplaceQuote;
  runtime: SellerRuntime;
}

type Outcome = "complete" | "incomplete" | "failed" | "uncertain";

interface FulfilmentRow {
  purchase_id: string;
  job_id: string;
  evidence_recorded_at: string | null;
  attempt_id: string | null;
  lease_generation: bigint | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  claims: bigint;
  outcome: Outcome | null;
  summary: string | null;
  artifact_id: string | null;
  artifact_text: string | null;
  artifact_sha256: string | null;
  artifact_bytes: bigint | null;
  fail_code: string | null;
  result_json: string | null;
  acked_at: string | null;
}

interface Lease {
  attemptId: string;
  leaseToken: string;
  leaseGeneration: number;
}

export interface FulfilPurchase {
  id: string;
  quote_id: string;
}

export interface FulfilCallbacks {
  /** Records the terminal gateway purchase state; called only after the marketplace acknowledged the outcome. */
  complete(state: "delivered" | "incomplete" | "paid_no_result", result: unknown, errorCode: string | null): void;
  /** Annotates a still-finalized purchase with why fulfilment is waiting (null clears it). */
  waiting(code: GatewayErrorCode | null): void;
}

const ok = (r: MarketplaceResponse) => r.status >= 200 && r.status < 300;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Marketplace side of the seller-host profile. Quotes are accepted only for a job the
 * marketplace reports awaiting payment under the same digest; work starts only after a
 * finalized payment has been reported and a lease granted. Inference is keyed by the
 * purchase, so a re-claimed lease reuses the single stored provider outcome.
 */
export class SellerHostService {
  constructor(private readonly ctx: GatewayContext) {}

  private get client(): MarketplaceClient {
    const c = this.ctx.marketplace;
    if (!c) throw new GatewayError(503, "NOT_READY", "Marketplace client is not configured");
    return c;
  }

  // ---- quoting -------------------------------------------------------------------------

  private async fetchJob(jobId: string): Promise<SellerHostJobView> {
    let res: MarketplaceResponse;
    try {
      res = await this.client.getJob(jobId);
    } catch (error) {
      if (error instanceof MarketplaceUnavailableError) throw new GatewayError(503, "NOT_READY", "Marketplace unreachable; no quote issued");
      throw error;
    }
    if (res.status === 404) throw new GatewayError(404, "NOT_FOUND", "Marketplace job not found");
    if (res.status !== 200) throw new GatewayError(503, "NOT_READY", `Marketplace job lookup failed (HTTP ${res.status})`);
    const parsed = sellerHostJobViewSchema.safeParse(res.body);
    if (!parsed.success) throw new GatewayError(503, "NOT_READY", "Marketplace returned an invalid job view");
    if (parsed.data.jobId !== jobId) throw new GatewayError(409, "PRICE_CHANGED", "Marketplace returned a different job");
    return parsed.data;
  }

  async verifyJob(input: SpecialistJobInput): Promise<SpecialistQuoteTerms> {
    const s = this.ctx.settings;
    const view = await this.fetchJob(input.jobId);
    if (view.state !== "awaiting_payment") throw new GatewayError(409, "NOT_READY", `Job is ${view.state}, not awaiting payment`);
    const q = view.quote;
    const problem = verifyQuote(q);
    if (problem) throw new GatewayError(409, "PRICE_CHANGED", `Marketplace quote rejected: ${problem}`);
    if (q.quoteDigest !== input.quoteDigest) throw new GatewayError(409, "PRICE_CHANGED", "Quote digest does not match the job's current quote");
    if (q.jobId !== input.jobId) throw new GatewayError(409, "PRICE_CHANGED", "Quote is for a different job");
    if (q.listingVersionId !== input.listingVersionId || view.listingVersionId !== input.listingVersionId) {
      throw new GatewayError(409, "PRICE_CHANGED", "Listing version does not match the quote");
    }
    if (computeInputDigest(input.brief) !== q.inputDigest) throw new GatewayError(409, "PRICE_CHANGED", "Brief does not match the quoted input digest");
    if (q.runtimeVersion !== view.runtime.runtimeVersionId) throw new GatewayError(409, "PRICE_CHANGED", "Runtime version does not match the quote");
    if (q.network !== s.network || q.genesisHash !== s.genesisHash) throw new GatewayError(409, "WRONG_NETWORK", "Quote network does not match this host");
    if (q.mint !== s.mint || q.decimals !== s.mintDecimals) throw new GatewayError(409, "WRONG_MINT", "Quote mint or decimals do not match this host");
    if (q.recipientAta !== (await deriveAta(q.recipient, q.mint))) {
      throw new GatewayError(409, "SERVICE_NOT_ALLOWED", "Quote recipient ATA is not the recipient's derived ATA");
    }
    const allowed = s.sellerHost?.allowedRecipients ?? [];
    if (allowed.length > 0 && !allowed.includes(q.recipient)) {
      throw new GatewayError(409, "SERVICE_NOT_ALLOWED", "Quote recipient is not an allowed payout address for this host");
    }
    if (q.sellerOrigin !== s.origin || q.sellerIdentity !== s.identity) {
      throw new GatewayError(409, "SERVICE_NOT_ALLOWED", "Quote names a different seller origin or identity");
    }
    const now = this.ctx.now().getTime();
    const expiresAt = Date.parse(q.expiresAt);
    if (now >= expiresAt) throw new GatewayError(410, "QUOTE_EXPIRED", "Marketplace quote has expired");
    const amount = BigInt(q.totalUnits);
    if (amount <= 0n) throw new GatewayError(409, "SERVICE_NOT_ALLOWED", "Free jobs are not sold through x402");

    const runtime = view.runtime;
    if (runtime.kind !== "managed_template" || runtime.template === null) {
      throw new GatewayError(409, "SERVICE_NOT_ALLOWED", "This host runs managed templates only");
    }
    if (runtime.outputFormat !== "markdown") throw new GatewayError(409, "SERVICE_NOT_ALLOWED", "This host delivers Markdown output only");
    const pinned = this.ctx.inference.modelFor("inference")?.id;
    if (runtime.modelId !== null && runtime.modelId !== pinned) {
      throw new GatewayError(409, "SERVICE_NOT_ALLOWED", "Listing names a model this host does not run");
    }
    const maxInputTokens = SPECIALIST.maxInputTokens as number;
    const maxOutputTokens = Math.min(runtime.maxOutputTokens, SPECIALIST.maxOutputTokens as number);
    const bound = conservativeInputTokens(this.messages(runtime, input.brief));
    if (bound > maxInputTokens) throw new GatewayError(413, "INPUT_TOO_LONG", `Brief and instructions exceed the ${maxInputTokens} token bound`);

    return {
      amount,
      payTo: q.recipient,
      merchantAta: q.recipientAta,
      expiresAt: new Date(Math.min(now + s.quoteTtlSeconds * 1000, expiresAt)),
      maxInputTokens,
      maxOutputTokens,
      marketplaceQuote: q,
      runtime,
    };
  }

  private messages(runtime: SellerRuntime, brief: string) {
    return buildTemplateMessages({
      template: runtime.template as ManagedTemplate,
      sellerInstructions: runtime.sellerInstructions,
      sections: runtime.sections,
      brief,
    });
  }

  /** Records the job binding for a new gateway quote. Runs inside the quote-insert transaction. */
  bindQuote(quoteId: string, accountId: string, operationId: string, terms: SpecialistQuoteTerms): void {
    const db = this.ctx.db;
    const now = this.ctx.now().toISOString();
    const jobId = terms.marketplaceQuote.jobId;
    const job = db.prepare("SELECT account_id, operation_id FROM seller_jobs WHERE job_id = ?").get(jobId) as
      | { account_id: string; operation_id: string }
      | undefined;
    if (job && (job.account_id !== accountId || job.operation_id !== operationId)) {
      throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "This job is already quoted to another operation");
    }
    if (!job) db.prepare("INSERT INTO seller_jobs (job_id, account_id, operation_id, created_at) VALUES (?, ?, ?, ?)").run(jobId, accountId, operationId, now);
    db.prepare("INSERT INTO seller_quotes (quote_id, job_id, marketplace_quote_json, runtime_json, created_at) VALUES (?, ?, ?, ?, ?)").run(
      quoteId,
      jobId,
      JSON.stringify(terms.marketplaceQuote),
      JSON.stringify(terms.runtime),
      now,
    );
  }

  private sellerQuote(quoteId: string): { jobId: string; quote: MarketplaceQuote; runtime: SellerRuntime } {
    const row = this.ctx.db.prepare("SELECT job_id, marketplace_quote_json, runtime_json FROM seller_quotes WHERE quote_id = ?").get(quoteId) as
      | { job_id: string; marketplace_quote_json: string; runtime_json: string }
      | undefined;
    if (!row) throw new GatewayError(409, "SERVICE_NOT_ALLOWED", "Quote has no marketplace job binding");
    return { jobId: row.job_id, quote: JSON.parse(row.marketplace_quote_json) as MarketplaceQuote, runtime: JSON.parse(row.runtime_json) as SellerRuntime };
  }

  /** Before a challenge or a payment: the job must still await payment under the quoted digest. */
  async assertPayable(quoteId: string): Promise<void> {
    const bound = this.sellerQuote(quoteId);
    const view = await this.fetchJob(bound.jobId);
    if (view.state !== "awaiting_payment") throw new GatewayError(409, "NOT_READY", `Job is ${view.state}, not awaiting payment`);
    if (view.quote.quoteDigest !== bound.quote.quoteDigest) throw new GatewayError(409, "PRICE_CHANGED", "The job's quote changed after this quote was issued");
  }

  // ---- fulfilment ----------------------------------------------------------------------

  private row(purchaseId: string): FulfilmentRow {
    return this.ctx.db.prepare("SELECT * FROM seller_fulfilments WHERE purchase_id = ?").get(purchaseId) as FulfilmentRow;
  }

  private update(purchaseId: string, fields: Record<string, unknown>): void {
    const sets = ["updated_at = ?"];
    const values: unknown[] = [this.ctx.now().toISOString()];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      values.push(v);
    }
    this.ctx.db.prepare(`UPDATE seller_fulfilments SET ${sets.join(", ")} WHERE purchase_id = ?`).run(...values, purchaseId);
  }

  private lease(f: FulfilmentRow): Lease | undefined {
    if (f.attempt_id === null || f.lease_token === null || f.lease_generation === null) return undefined;
    return { attemptId: f.attempt_id, leaseToken: f.lease_token, leaseGeneration: Number(f.lease_generation) };
  }

  private dropLease(purchaseId: string): void {
    this.update(purchaseId, { attempt_id: null, lease_token: null, lease_generation: null, lease_expires_at: null });
  }

  /**
   * Drives one finalized purchase forward. Every step is persisted before the next starts,
   * so a restart resumes at the first step without a durable record.
   */
  async fulfil(p: FulfilPurchase, paymentSignature: string, cb: FulfilCallbacks): Promise<void> {
    const bound = this.sellerQuote(p.quote_id);
    const now = this.ctx.now().toISOString();
    this.ctx.db
      .prepare("INSERT OR IGNORE INTO seller_fulfilments (purchase_id, job_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(p.id, bound.jobId, now, now);
    const input = JSON.parse(
      (this.ctx.db.prepare("SELECT input_json FROM quotes WHERE id = ?").get(p.quote_id) as { input_json: string }).input_json,
    ) as SpecialistJobInput;
    const maxOutputTokens = Number(
      (this.ctx.db.prepare("SELECT max_output_tokens FROM quotes WHERE id = ?").get(p.quote_id) as { max_output_tokens: bigint }).max_output_tokens,
    );

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const f = this.row(p.id);
      if (f.acked_at !== null) {
        const state = f.outcome === "complete" ? "delivered" : f.outcome === "incomplete" ? "incomplete" : "paid_no_result";
        cb.complete(state, JSON.parse(f.result_json as string), state === "paid_no_result" ? "PAID_NO_RESULT" : null);
        return;
      }
      try {
        if (f.evidence_recorded_at === null) {
          const evidence = await this.recordEvidence(p.id, bound.jobId, bound.quote.operationId, paymentSignature);
          if (evidence === "retry") return cb.waiting("NOT_READY");
          if (evidence !== "recorded") {
            // The payment is final on chain but the marketplace will not queue the job for it;
            // the purchase closes visibly as paid without a result instead of waiting forever.
            return cb.complete(
              "paid_no_result",
              { kind: "specialist_job", jobId: bound.jobId, status: "evidence_refused", code: evidence.code, message: evidence.message },
              evidence.code,
            );
          }
          continue;
        }
        const lease = this.lease(f);
        if (!lease) {
          const claimed = await this.claim(p.id, bound.jobId);
          if (claimed !== "claimed") return cb.waiting(claimed === "unavailable" ? "NOT_READY" : null);
          continue;
        }
        if (f.outcome === null) {
          const step = await this.run(p.id, bound, lease, input.brief, maxOutputTokens);
          if (step.stop) return cb.waiting(step.code);
          continue;
        }
        const reported = await this.report(f, lease);
        if (reported === "retry") return cb.waiting("NOT_READY");
      } catch (error) {
        if (error instanceof MarketplaceUnavailableError) return cb.waiting("NOT_READY");
        throw error;
      }
    }
    cb.waiting("NOT_READY");
  }

  /**
   * 202 (payer not bound yet), 5xx, 401, 408 and 429 are retried; a network error propagates as
   * MarketplaceUnavailableError and is retried by the caller. Any other refusal is final.
   */
  private async recordEvidence(
    purchaseId: string,
    jobId: string,
    operationId: string,
    signature: string,
  ): Promise<"recorded" | "retry" | { code: string; message: string }> {
    const res = await this.client.paymentEvidence(jobId, { operationId, signature });
    if (res.status === 202 || res.status >= 500 || res.status === 401 || res.status === 408 || res.status === 429) return "retry";
    // An already-recorded receipt comes back as 2xx; a 409 is a genuine conflict (another receipt,
    // a reused or refund signature) and must stay visible rather than be taken as recorded.
    if (ok(res)) {
      this.update(purchaseId, { evidence_recorded_at: this.ctx.now().toISOString() });
      return "recorded";
    }
    const err = (res.body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    const code = typeof err?.code === "string" && /^[A-Z][A-Z0-9_]{0,59}$/.test(err.code) ? err.code : res.status === 403 ? "SERVICE_NOT_ALLOWED" : `EVIDENCE_REFUSED_${res.status}`;
    const message = typeof err?.message === "string" ? err.message.slice(0, 300) : `Marketplace refused the payment evidence (HTTP ${res.status})`;
    return { code, message };
  }

  private async claim(purchaseId: string, jobId: string): Promise<"claimed" | "not_queued" | "unavailable"> {
    const delays = [0, ...(this.ctx.settings.sellerHost?.claimRetryDelaysMs ?? [])];
    let unavailable = false;
    for (const delay of delays) {
      if (delay > 0) await this.ctx.sleep(delay);
      let res: MarketplaceResponse;
      try {
        res = await this.client.claim(jobId);
      } catch (error) {
        if (!(error instanceof MarketplaceUnavailableError)) throw error;
        unavailable = true;
        continue;
      }
      unavailable = res.status >= 500;
      if (!ok(res)) continue;
      const grant = leaseGrantSchema.safeParse(res.body);
      if (!grant.success) {
        unavailable = true;
        continue;
      }
      const g = grant.data;
      immediate(this.ctx.db, () => {
        const claims = this.row(purchaseId).claims;
        this.update(purchaseId, {
          attempt_id: g.attemptId,
          lease_generation: g.leaseGeneration,
          lease_token: g.leaseToken,
          lease_expires_at: g.leaseExpiresAt,
          claims: claims + 1n,
        });
      });
      return "claimed";
    }
    return unavailable ? "unavailable" : "not_queued";
  }

  /** Returns false when the marketplace says the lease is no longer ours. */
  private async heartbeat(purchaseId: string, jobId: string, lease: Lease): Promise<boolean> {
    const res = await this.client.heartbeat(jobId, { attemptId: lease.attemptId, leaseToken: lease.leaseToken });
    if (ok(res)) {
      const expires = (res.body as { leaseExpiresAt?: unknown } | undefined)?.leaseExpiresAt;
      if (typeof expires === "string") this.update(purchaseId, { lease_expires_at: expires });
      return true;
    }
    if (res.status >= 500) throw new MarketplaceUnavailableError(`heartbeat failed (HTTP ${res.status})`);
    return false;
  }

  private async run(
    purchaseId: string,
    bound: { jobId: string; runtime: SellerRuntime },
    lease: Lease,
    brief: string,
    maxOutputTokens: number,
  ): Promise<{ stop: false } | { stop: true; code: GatewayErrorCode | null }> {
    // Nothing is sent upstream unless the marketplace confirms the lease is live right now.
    if (!this.ctx.inference.existing("purchase", purchaseId) && !(await this.heartbeat(purchaseId, bound.jobId, lease))) {
      this.dropLease(purchaseId);
      return { stop: false };
    }
    const every = this.ctx.settings.sellerHost?.heartbeatMs ?? 15_000;
    const timer = setInterval(() => {
      this.heartbeat(purchaseId, bound.jobId, lease).catch(() => undefined);
    }, every);
    timer.unref();
    let outcome: InferenceOutcome;
    try {
      outcome = await this.ctx.inference.run({
        sourceKind: "purchase",
        sourceId: purchaseId,
        purpose: "x402",
        role: "inference",
        messages: this.messages(bound.runtime, brief),
        maxInputTokens: SPECIALIST.maxInputTokens as number,
        maxOutputTokens,
        jsonObject: false,
      });
    } finally {
      clearInterval(timer);
    }

    const template = bound.runtime.template as ManagedTemplate;
    switch (outcome.status) {
      case "rejected":
        // Not dispatched; the lease lapses and a later pass re-claims once the provider is ready.
        return { stop: true, code: outcome.code };
      case "succeeded": {
        const text = outcome.text;
        const missing = missingSections(text, bound.runtime.sections);
        const status = text.trim() !== "" && missing.length === 0 && outcome.finishReason !== "length" ? "complete" : "incomplete";
        const artifact = { artifactId: randomUUID(), sha256: sha256(text), mimeType: "text/markdown" as const, bytes: Buffer.byteLength(text, "utf8") };
        const summary = summarize(text, `${template} deliverable`);
        this.update(purchaseId, {
          outcome: status,
          summary,
          artifact_id: artifact.artifactId,
          artifact_text: text,
          artifact_sha256: artifact.sha256,
          artifact_bytes: artifact.bytes,
          result_json: JSON.stringify({
            kind: "specialist_job",
            jobId: bound.jobId,
            template,
            status,
            summary,
            missingSections: missing,
            artifacts: [artifact],
            delivery: "Artifact bodies are delivered through the marketplace job",
            provenance: provenanceOf(outcome),
          }),
        });
        return { stop: false };
      }
      case "failed":
      case "uncertain": {
        const uncertain = outcome.status === "uncertain";
        this.update(purchaseId, {
          outcome: outcome.status,
          fail_code: uncertain ? "PROVIDER_UNCERTAIN" : "PROVIDER_FAILED",
          result_json: JSON.stringify({ kind: "specialist_job", jobId: bound.jobId, template, status: outcome.status, message: outcome.message }),
        });
        return { stop: false };
      }
    }
  }

  /** Reports the stored outcome under the current lease. Never re-runs inference. */
  private async report(f: FulfilmentRow, lease: Lease): Promise<"acked" | "lease_lost" | "retry"> {
    const succeeded = f.outcome === "complete" || f.outcome === "incomplete";
    let res: MarketplaceResponse;
    if (succeeded) {
      const envelope = resultEnvelopeSchema.parse({
        jobId: f.job_id,
        attemptId: lease.attemptId,
        leaseGeneration: lease.leaseGeneration,
        schemaVersion: "veilo.result.v1",
        status: f.outcome,
        summary: f.summary,
        artifacts: [
          { artifactId: f.artifact_id, sha256: f.artifact_sha256, mimeType: "text/markdown", bytes: Number(f.artifact_bytes) },
        ],
        sourceReferences: [],
      });
      const body = completeRequestSchema.parse({
        attemptId: lease.attemptId,
        leaseToken: lease.leaseToken,
        envelope,
        artifactBodies: [{ artifactId: f.artifact_id, text: f.artifact_text }],
      });
      res = await this.client.complete(f.job_id, body);
    } else {
      res = await this.client.fail(f.job_id, {
        attemptId: lease.attemptId,
        leaseToken: lease.leaseToken,
        code: f.fail_code as string,
        uncertain: f.outcome === "uncertain",
      });
    }
    if (res.status >= 500) return "retry";
    if (!ok(res)) {
      // A refusal is either a lost lease or an outcome the marketplace already holds; its job state decides.
      const view = await this.client.getJob(f.job_id);
      const parsed = view.status === 200 ? sellerHostJobViewSchema.safeParse(view.body) : undefined;
      if (!parsed?.success) return "retry";
      const done = succeeded ? ["succeeded"] : ["failed", "delivery_uncertain"];
      if (!done.includes(parsed.data.state)) {
        this.dropLease(f.purchase_id);
        return "lease_lost";
      }
    }
    this.update(f.purchase_id, { acked_at: this.ctx.now().toISOString() });
    return "acked";
  }
}
