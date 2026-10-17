import { randomUUID } from "node:crypto";
import { immediate, type GatewayDb } from "./db/database";
import { GatewayError, type GatewayErrorCode } from "./errors";
import { reserveOperatorCost, resolveOperatorCost, type OperatorPurpose } from "./ledger/operator";
import { usdPerMillion, worstCaseMicroUsd, type PinnedModel } from "./provider/pinned-models";
import type { PricingGuard } from "./provider/pricing";
import { conservativeInputTokens, type ChatMessage } from "./provider/token-bound";
import { ProviderError, type ChatProvider } from "./provider/types";

export type SourceKind = "purchase" | "usage" | "planning" | "smoke";

export interface InferenceRequest {
  sourceKind: SourceKind;
  sourceId: string;
  purpose: OperatorPurpose;
  role: "inference" | "planner";
  messages: ChatMessage[];
  maxInputTokens: number;
  maxOutputTokens: number;
  jsonObject: boolean;
}

export type InferenceOutcome =
  | {
      status: "succeeded";
      executionId: string;
      text: string;
      model: string;
      reportedModel: string | null;
      mode: "live" | "fixture";
      promptTokens: number | null;
      completionTokens: number | null;
      costMicro: string | null;
      finishReason: string | null;
    }
  /** Refused before dispatch; no provider request was sent and no cost was reserved. */
  | { status: "rejected"; code: GatewayErrorCode; message: string }
  /** The provider proved the request was not executed; the cost reservation was released. */
  | { status: "failed"; executionId: string; code: GatewayErrorCode; message: string }
  /** Outcome unknown; reservations are retained and no automatic retry happens. */
  | { status: "uncertain"; executionId: string; message: string };

export interface InferenceDeps {
  db: GatewayDb;
  provider: ChatProvider | null;
  providerDisabledReason: string | undefined;
  pricing: PricingGuard;
  models: { inference: PinnedModel | undefined; planner: PinnedModel | undefined };
  ceilingMicro: bigint;
  timeoutMs: number;
  now: () => Date;
  /** Test-only fault injection points. */
  hooks?: { beforeProviderCall?: () => void } | undefined;
}

interface ExecutionRow {
  id: string;
  state: "started" | "succeeded" | "failed" | "uncertain";
  model: string;
  mode: "live" | "fixture";
  reported_model: string | null;
  prompt_tokens: bigint | null;
  completion_tokens: bigint | null;
  output_text: string | null;
  failure: string | null;
}

/**
 * Bounded provider execution. At most one upstream attempt per source: the execution row
 * is unique per (source kind, source id) and is persisted before the request is sent.
 */
export class InferenceService {
  readonly #inflight = new Map<string, Promise<InferenceOutcome>>();

  constructor(private readonly deps: InferenceDeps) {}

  modelFor(role: "inference" | "planner"): PinnedModel | undefined {
    return role === "inference" ? this.deps.models.inference : this.deps.models.planner;
  }

  readiness(role: "inference" | "planner"): { ready: true } | { ready: false; code: GatewayErrorCode; reason: string } {
    if (!this.deps.provider) {
      return { ready: false, code: "PROVIDER_UNAVAILABLE", reason: this.deps.providerDisabledReason ?? "no provider configured" };
    }
    const model = this.modelFor(role);
    if (!model) return { ready: false, code: "PROVIDER_UNAVAILABLE", reason: `${role} model is not an allowlisted pinned model` };
    const pricing = this.deps.pricing.status(model, this.deps.now());
    if (!pricing.ok) return { ready: false, code: pricing.code, reason: pricing.reason };
    return { ready: true };
  }

  get mode(): "live" | "fixture" | "disabled" {
    return this.deps.provider?.mode ?? "disabled";
  }

  run(request: InferenceRequest): Promise<InferenceOutcome> {
    const key = `${request.sourceKind}:${request.sourceId}`;
    const pending = this.#inflight.get(key);
    if (pending) return pending;
    const promise = this.#run(request).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);
    return promise;
  }

  /** Stored outcome for a source, without dispatching. */
  existing(sourceKind: SourceKind, sourceId: string): InferenceOutcome | undefined {
    if (this.#inflight.has(`${sourceKind}:${sourceId}`)) return undefined;
    return this.#stored(sourceKind, sourceId);
  }

  #stored(sourceKind: SourceKind, sourceId: string): InferenceOutcome | undefined {
    const row = this.deps.db
      .prepare(
        "SELECT id, state, model, mode, reported_model, prompt_tokens, completion_tokens, output_text, failure FROM provider_executions WHERE source_kind = ? AND source_id = ?",
      )
      .get(sourceKind, sourceId) as ExecutionRow | undefined;
    return row ? this.#fromRow(row) : undefined;
  }

  #fromRow(row: ExecutionRow): InferenceOutcome {
    switch (row.state) {
      case "succeeded": {
        const cost = this.deps.db
          .prepare("SELECT actual_micro FROM operator_cost_ledger WHERE execution_id = ?")
          .get(row.id) as { actual_micro: bigint | null } | undefined;
        return {
          status: "succeeded",
          executionId: row.id,
          text: row.output_text ?? "",
          model: row.model,
          reportedModel: row.reported_model,
          mode: row.mode,
          promptTokens: row.prompt_tokens === null ? null : Number(row.prompt_tokens),
          completionTokens: row.completion_tokens === null ? null : Number(row.completion_tokens),
          costMicro: cost?.actual_micro?.toString() ?? null,
          finishReason: null,
        };
      }
      case "failed":
        return { status: "failed", executionId: row.id, code: "PROVIDER_UNAVAILABLE", message: row.failure ?? "provider failed" };
      default:
        // A started execution with no live request in this process is ambiguous.
        return { status: "uncertain", executionId: row.id, message: row.failure ?? "provider outcome unknown" };
    }
  }

  async #run(request: InferenceRequest): Promise<InferenceOutcome> {
    const prior = this.#stored(request.sourceKind, request.sourceId);
    if (prior) return prior;

    const ready = this.readiness(request.role);
    if (!ready.ready) return { status: "rejected", code: ready.code, message: ready.reason };
    const provider = this.deps.provider as ChatProvider;
    const model = this.modelFor(request.role) as PinnedModel;

    const inputBound = conservativeInputTokens(request.messages);
    if (inputBound > request.maxInputTokens) {
      return {
        status: "rejected",
        code: "INPUT_TOO_LONG",
        message: `input exceeds the enforced bound of ${request.maxInputTokens} tokens (conservative count ${inputBound})`,
      };
    }
    if (request.maxOutputTokens > model.maxCompletionTokens || inputBound + request.maxOutputTokens > model.contextLength) {
      return { status: "rejected", code: "PROVIDER_UNAVAILABLE", message: "SKU bounds exceed the pinned model limits" };
    }
    const worstCase = worstCaseMicroUsd(model, request.maxInputTokens, request.maxOutputTokens);

    const executionId = `exe_${randomUUID()}`;
    const startedAt = this.deps.now();
    try {
      immediate(this.deps.db, () => {
        this.deps.db
          .prepare(
            "INSERT INTO provider_executions (id, source_kind, source_id, model, max_input_tokens, max_output_tokens, state, mode, started_at) VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?)",
          )
          .run(
            executionId,
            request.sourceKind,
            request.sourceId,
            model.id,
            request.maxInputTokens,
            request.maxOutputTokens,
            provider.mode,
            startedAt.toISOString(),
          );
        reserveOperatorCost(this.deps.db, {
          executionId,
          model: model.id,
          purpose: request.purpose,
          worstCaseMicro: worstCase,
          ceilingMicro: this.deps.ceilingMicro,
          at: startedAt,
        });
      });
    } catch (error) {
      if (error instanceof GatewayError) return { status: "rejected", code: error.code, message: error.message };
      if (String((error as Error).message).includes("UNIQUE")) {
        const again = this.#stored(request.sourceKind, request.sourceId);
        if (again) return again;
      }
      throw error;
    }

    this.deps.hooks?.beforeProviderCall?.();
    try {
      const result = await provider.complete(
        {
          model: model.id,
          messages: request.messages,
          maxOutputTokens: request.maxOutputTokens,
          jsonObject: request.jsonObject,
          maxPrice: { prompt: usdPerMillion(model.promptPicoPerToken), completion: usdPerMillion(model.completionPicoPerToken) },
        },
        AbortSignal.timeout(this.deps.timeoutMs),
      );
      const now = this.deps.now();
      const computed =
        result.promptTokens !== undefined && result.completionTokens !== undefined
          ? worstCaseMicroUsd(model, result.promptTokens, result.completionTokens)
          : null;
      const actual = result.costMicro ?? computed;
      immediate(this.deps.db, () => {
        this.deps.db
          .prepare(
            `UPDATE provider_executions SET state = 'succeeded', finished_at = ?, http_status = ?, generation_id = ?, reported_model = ?,
               prompt_tokens = ?, completion_tokens = ?, output_text = ? WHERE id = ? AND state = 'started'`,
          )
          .run(
            now.toISOString(),
            result.httpStatus,
            result.generationId ?? null,
            result.reportedModel ?? null,
            result.promptTokens ?? null,
            result.completionTokens ?? null,
            result.text,
            executionId,
          );
        resolveOperatorCost(
          this.deps.db,
          executionId,
          {
            state: "settled",
            actualMicro: actual,
            source: result.costMicro !== undefined ? "provider_reported" : computed !== null ? "pinned_tariff_x_usage" : "worst_case",
          },
          now,
        );
      });
      return {
        status: "succeeded",
        executionId,
        text: result.text,
        model: model.id,
        reportedModel: result.reportedModel ?? null,
        mode: provider.mode,
        promptTokens: result.promptTokens ?? null,
        completionTokens: result.completionTokens ?? null,
        costMicro: actual?.toString() ?? null,
        finishReason: result.finishReason ?? null,
      };
    } catch (error) {
      const now = this.deps.now();
      const definite = error instanceof ProviderError && error.kind === "definite";
      const message = error instanceof ProviderError ? error.message : "provider call failed unexpectedly";
      immediate(this.deps.db, () => {
        this.deps.db
          .prepare("UPDATE provider_executions SET state = ?, finished_at = ?, http_status = ?, failure = ? WHERE id = ? AND state = 'started'")
          .run(
            definite ? "failed" : "uncertain",
            now.toISOString(),
            error instanceof ProviderError ? (error.httpStatus ?? null) : null,
            message,
            executionId,
          );
        resolveOperatorCost(this.deps.db, executionId, definite ? { state: "released" } : { state: "uncertain" }, now);
      });
      return definite
        ? { status: "failed", executionId, code: "PROVIDER_UNAVAILABLE", message }
        : { status: "uncertain", executionId, message };
    }
  }

  /** After a restart, executions left `started` are ambiguous: mark them uncertain. */
  markInterruptedUncertain(): number {
    const now = this.deps.now();
    return immediate(this.deps.db, () => {
      const rows = this.deps.db.prepare("SELECT id FROM provider_executions WHERE state = 'started'").all() as Array<{ id: string }>;
      for (const r of rows) {
        this.deps.db
          .prepare("UPDATE provider_executions SET state = 'uncertain', failure = 'interrupted before the outcome was recorded' WHERE id = ?")
          .run(r.id);
        resolveOperatorCost(this.deps.db, r.id, { state: "uncertain" }, now);
      }
      return rows.length;
    });
  }
}

/** Provenance attached to every delivered model output; fixture output is labeled as such. */
export function provenanceOf(outcome: Extract<InferenceOutcome, { status: "succeeded" }>) {
  return {
    model: outcome.model,
    reportedModel: outcome.reportedModel,
    mode: outcome.mode,
    label:
      outcome.mode === "live"
        ? "Real model output via the operator-funded OpenRouter account"
        : "FIXTURE: mock provider used by automated tests; not real inference",
    usage: { promptTokens: outcome.promptTokens, completionTokens: outcome.completionTokens },
    providerCostMicroUsd: outcome.costMicro,
    finishReason: outcome.finishReason,
  };
}
