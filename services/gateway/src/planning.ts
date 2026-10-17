import { randomUUID } from "node:crypto";
import { MAX_PLANNING_CALLS_PER_TASK, planningRequestSchema, SPONSORED_PLANNING_LABEL } from "@veilo/contracts/gateway";
import { tokenMatchesHash } from "./auth";
import type { GatewayContext } from "./context";
import { immediate } from "./db/database";
import { GatewayError } from "./errors";
import type { HttpResult } from "./purchases";

export const PLANNING_MAX_INPUT_TOKENS = 4_000;
export const PLANNING_MAX_OUTPUT_TOKENS = 800;

/**
 * Operator-sponsored planning for the runner: at most two calls per task, fixed planner
 * model, bounded input/output, and the same operator dollar reservation as paid calls.
 * Each call slot is consumed when requested, whatever the provider outcome.
 */
export class PlanningService {
  constructor(private readonly ctx: GatewayContext) {}

  async complete(authorization: string | undefined, body: unknown): Promise<HttpResult> {
    if (!tokenMatchesHash(authorization, this.ctx.planningTokenHash)) {
      throw new GatewayError(401, "UNAUTHENTICATED", "Planning credential required");
    }
    const parsed = planningRequestSchema.safeParse(body);
    if (!parsed.success) throw new GatewayError(400, "BAD_REQUEST", "Invalid planning request");
    const ready = this.ctx.inference.readiness("planner");
    if (!ready.ready) throw new GatewayError(503, ready.code, `Planner unavailable: ${ready.reason}`);

    const { taskRef, purpose, messages } = parsed.data;
    const callId = `pln_${randomUUID()}`;
    const callIndex = immediate(this.ctx.db, () => {
      const row = this.ctx.db.prepare("SELECT COUNT(*) AS n FROM planning_calls WHERE task_ref = ?").get(taskRef) as { n: bigint };
      const used = Number(row.n);
      if (used >= MAX_PLANNING_CALLS_PER_TASK) {
        throw new GatewayError(429, "PLANNING_LIMIT_REACHED", `Task already used ${MAX_PLANNING_CALLS_PER_TASK} sponsored planning calls`);
      }
      this.ctx.db
        .prepare("INSERT INTO planning_calls (id, task_ref, call_index, purpose, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(callId, taskRef, used + 1, purpose, this.ctx.now().toISOString());
      return used + 1;
    });

    const outcome = await this.ctx.inference.run({
      sourceKind: "planning",
      sourceId: callId,
      purpose: "planning",
      role: "planner",
      messages,
      maxInputTokens: PLANNING_MAX_INPUT_TOKENS,
      maxOutputTokens: Math.min(parsed.data.maxOutputTokens ?? PLANNING_MAX_OUTPUT_TOKENS, PLANNING_MAX_OUTPUT_TOKENS),
      jsonObject: false,
    });
    const result = {
      label: SPONSORED_PLANNING_LABEL,
      taskRef,
      callIndex,
      remainingCalls: MAX_PLANNING_CALLS_PER_TASK - callIndex,
      outcome:
        outcome.status === "succeeded"
          ? {
              status: "succeeded",
              text: outcome.text,
              model: outcome.model,
              mode: outcome.mode,
              usage: { promptTokens: outcome.promptTokens, completionTokens: outcome.completionTokens },
              providerCostMicroUsd: outcome.costMicro,
            }
          : outcome,
    };
    this.ctx.db.prepare("UPDATE planning_calls SET result_json = ? WHERE id = ?").run(JSON.stringify(result), callId);
    const status = outcome.status === "succeeded" ? 200 : outcome.status === "uncertain" ? 202 : 503;
    return { status, body: result };
  }
}
