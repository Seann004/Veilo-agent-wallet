import { randomUUID } from "node:crypto";
import type { GatewayDb } from "../db/database";
import { OPENROUTER_MODELS_URL, parseUsdDecimal, type PinnedModel } from "./pinned-models";
import type { FetchLike } from "./types";

export interface LivePrice {
  promptPico: bigint;
  completionPico: bigint;
  requestPico: bigint;
}

/** Fetches public per-token pricing (no credential) for the given model IDs. */
export async function fetchLivePricing(
  modelIds: readonly string[],
  fetchImpl: FetchLike = fetch,
  timeoutMs = 20_000,
): Promise<Map<string, LivePrice | null>> {
  const response = await fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!response.ok) throw new Error(`models endpoint returned HTTP ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: unknown; pricing?: Record<string, unknown> }> };
  const result = new Map<string, LivePrice | null>();
  for (const id of modelIds) {
    const entry = body.data?.find((m) => m.id === id);
    const prompt = parseUsdDecimal(entry?.pricing?.prompt, 12);
    const completion = parseUsdDecimal(entry?.pricing?.completion, 12);
    const request = entry?.pricing?.request === undefined ? 0n : parseUsdDecimal(entry.pricing.request, 12);
    result.set(
      id,
      prompt === undefined || completion === undefined || request === undefined
        ? null
        : { promptPico: prompt, completionPico: completion, requestPico: request },
    );
  }
  return result;
}

export type PricingStatus =
  | { ok: true; fetchedAt: string }
  | { ok: false; code: "PROVIDER_UNAVAILABLE" | "PRICE_CHANGED"; reason: string };

/**
 * Durable record of pricing observations. A model may be dispatched only if its latest
 * observation is recent and no higher than the pinned tariff.
 */
export class PricingGuard {
  constructor(
    private readonly db: GatewayDb,
    private readonly maxAgeSeconds: number,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async refresh(models: readonly PinnedModel[], now: Date): Promise<void> {
    let live: Map<string, LivePrice | null>;
    try {
      live = await fetchLivePricing(
        models.map((m) => m.id),
        this.fetchImpl,
      );
    } catch (error) {
      for (const m of models) this.record(m.id, null, `pricing fetch failed: ${(error as Error).message}`, now);
      return;
    }
    for (const m of models) {
      const price = live.get(m.id) ?? null;
      this.record(m.id, price, price === null ? "model not listed or pricing unparseable" : null, now);
    }
  }

  private record(model: string, price: LivePrice | null, detail: string | null, now: Date): void {
    this.db
      .prepare(
        "INSERT INTO pricing_checks (id, model, prompt_pico, completion_pico, request_pico, ok, detail, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        `prc_${randomUUID()}`,
        model,
        price?.promptPico ?? null,
        price?.completionPico ?? null,
        price?.requestPico ?? null,
        price === null ? 0 : 1,
        detail,
        now.toISOString(),
      );
  }

  status(model: PinnedModel, now: Date): PricingStatus {
    const row = this.db
      .prepare(
        "SELECT prompt_pico, completion_pico, request_pico, ok, detail, fetched_at FROM pricing_checks WHERE model = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1",
      )
      .get(model.id) as
      | { prompt_pico: bigint | null; completion_pico: bigint | null; request_pico: bigint | null; ok: bigint; detail: string | null; fetched_at: string }
      | undefined;
    if (!row) return { ok: false, code: "PROVIDER_UNAVAILABLE", reason: "no pricing observation yet" };
    if (row.ok !== 1n) return { ok: false, code: "PROVIDER_UNAVAILABLE", reason: row.detail ?? "pricing unavailable" };
    const ageMs = now.getTime() - Date.parse(row.fetched_at);
    if (ageMs > this.maxAgeSeconds * 1000) {
      return { ok: false, code: "PROVIDER_UNAVAILABLE", reason: "pricing observation is stale" };
    }
    if (
      (row.prompt_pico ?? 0n) > model.promptPicoPerToken ||
      (row.completion_pico ?? 0n) > model.completionPicoPerToken ||
      (row.request_pico ?? 0n) > model.requestPico
    ) {
      return { ok: false, code: "PRICE_CHANGED", reason: "live provider price exceeds the pinned tariff" };
    }
    return { ok: true, fetchedAt: row.fetched_at };
  }
}
