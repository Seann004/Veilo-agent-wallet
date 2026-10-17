// Opt-in live inference smoke through the bounded gateway adapter: one OpenRouter chat
// completion with the pinned model, a small token cap, the operator dollar ledger and the
// pricing guard. Requires --confirm. The API key is never printed or written.
//
//   pnpm tsx scripts/smoke-inference.ts --confirm [--model mistralai/mistral-nemo]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { findRepoRoot, loadConfig, loadDotEnv } from "@veilo/contracts";
import { openGatewayDb } from "../services/gateway/src/db/database";
import { InferenceService } from "../services/gateway/src/inference";
import { operatorBudgetView } from "../services/gateway/src/ledger/operator";
import { OpenRouterProvider } from "../services/gateway/src/provider/openrouter";
import { pinnedModel, worstCaseMicroUsd } from "../services/gateway/src/provider/pinned-models";
import { PricingGuard } from "../services/gateway/src/provider/pricing";

const MAX_OUTPUT_TOKENS = 64;
const MAX_INPUT_TOKENS = 400;

const { values } = parseArgs({
  options: {
    confirm: { type: "boolean", default: false },
    // Rebuilds evidence for the latest stored smoke execution; makes no provider call.
    "from-db": { type: "boolean", default: false },
    model: { type: "string" },
  },
});

async function main() {
  const rootDir = findRepoRoot();
  loadDotEnv({ rootDir, allowProviderSecrets: true });
  const config = loadConfig(process.env, { rootDir });
  const modelId = values.model ?? config.inference.inferenceModelId ?? "mistralai/mistral-nemo";
  const model = pinnedModel(modelId);
  if (!model) throw new Error(`model ${modelId} is not an allowlisted pinned model`);
  if (!config.inference.realInferenceEnabled || !config.openRouterApiKey) {
    throw new Error("real inference disabled: set OPENROUTER_API_KEY and a positive OPERATOR_MAX_REAL_USD_MICRO");
  }
  const worst = worstCaseMicroUsd(model, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS);
  if (values["from-db"]) {
    const db = openGatewayDb(config.paths.gatewayDatabase);
    const row = db
      .prepare("SELECT source_id, started_at FROM provider_executions WHERE source_kind = 'smoke' ORDER BY started_at DESC LIMIT 1")
      .get() as { source_id: string; started_at: string } | undefined;
    if (!row) throw new Error("no stored smoke execution");
    const pricingCheck = new PricingGuard(db, 3600).status(model, new Date(row.started_at));
    const outcome = new InferenceService({
      db, provider: null, providerDisabledReason: "evidence rebuild", pricing: new PricingGuard(db, 3600),
      models: { inference: model, planner: model }, ceilingMicro: 0n, timeoutMs: 1, now: () => new Date(),
    }).existing("smoke", row.source_id);
    writeEvidence(rootDir, db, config.inference.operatorMaxRealUsdMicro, model, row.source_id, row.started_at, pricingCheck, worst, outcome);
    db.close();
    return;
  }
  if (!values.confirm) {
    console.log(JSON.stringify({ mode: "dry run (no provider call)", model: model.id, worstCaseMicroUsd: worst.toString(), maxOutputTokens: MAX_OUTPUT_TOKENS }));
    console.error("Refusing to call the provider without --confirm.");
    process.exitCode = 2;
    return;
  }

  const db = openGatewayDb(config.paths.gatewayDatabase);
  const now = () => new Date();
  const pricing = new PricingGuard(db, 3600);
  await pricing.refresh([model], now());
  const priceStatus = pricing.status(model, now());
  if (!priceStatus.ok) throw new Error(`pricing check failed: ${priceStatus.reason}`);

  const inference = new InferenceService({
    db,
    provider: new OpenRouterProvider(config.openRouterApiKey),
    providerDisabledReason: undefined,
    pricing,
    models: { inference: model, planner: model },
    ceilingMicro: config.inference.operatorMaxRealUsdMicro,
    timeoutMs: 60_000,
    now,
  });
  const sourceId = `smoke-${randomUUID()}`;
  const startedAt = now().toISOString();
  const outcome = await inference.run({
    sourceKind: "smoke",
    sourceId,
    purpose: "smoke",
    role: "inference",
    messages: [
      { role: "system", content: "Reply in one short sentence." },
      { role: "user", content: "Name one benefit of a community repair cafe." },
    ],
    maxInputTokens: MAX_INPUT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    jsonObject: false,
  });
  writeEvidence(rootDir, db, config.inference.operatorMaxRealUsdMicro, model, sourceId, startedAt, priceStatus, worst, outcome);
  db.close();
}

function writeEvidence(
  rootDir: string,
  db: ReturnType<typeof openGatewayDb>,
  ceiling: bigint,
  model: NonNullable<ReturnType<typeof pinnedModel>>,
  sourceId: string,
  startedAt: string,
  priceStatus: unknown,
  worst: bigint,
  outcome: unknown,
): void {
  const ledger = db
    .prepare("SELECT o.worst_case_micro, o.actual_micro, o.actual_source, o.state FROM operator_cost_ledger o JOIN provider_executions e ON e.id = o.execution_id WHERE e.source_id = ?")
    .get(sourceId) as Record<string, unknown> | undefined;
  const execution = db
    .prepare("SELECT id, state, http_status, generation_id, reported_model, prompt_tokens, completion_tokens, started_at, finished_at FROM provider_executions WHERE source_id = ?")
    .get(sourceId) as Record<string, unknown> | undefined;

  const evidence = {
    kind: "live OpenRouter inference smoke (operator-funded real inference)",
    label: "Real model output via the operator-funded OpenRouter account",
    startedAt,
    model: model.id,
    pinnedTariff: {
      promptPicoUsdPerToken: model.promptPicoPerToken.toString(),
      completionPicoUsdPerToken: model.completionPicoPerToken.toString(),
      pinnedAt: model.pinnedAt,
      source: model.source,
    },
    pricingCheck: priceStatus,
    bounds: { maxInputTokens: MAX_INPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS, worstCaseMicroUsd: worst.toString() },
    outcome,
    execution,
    operatorLedger: ledger,
    operatorBudget: operatorBudgetView(db, ceiling),
  };
  const dir = join(rootDir, "artifacts", "evidence");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `openrouter-inference-smoke-${startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, JSON.stringify(evidence, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(JSON.stringify({ evidence: path, status: (outcome as { status?: string } | undefined)?.status, model: model.id }));
}

main().catch((error: unknown) => {
  console.error(`smoke-inference failed: ${(error as Error).message}`);
  process.exit(1);
});
