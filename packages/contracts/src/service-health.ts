import { verifyChainIdentity, type ChainIdentityResult, type FetchLike } from "./chain-identity";
import type { VeiloConfig } from "./config";
import { VeiloConfigError } from "./errors";

export type ChainState =
  | { state: "not_required" }
  | { state: "pending" }
  | { state: "verified"; identity: ChainIdentityResult }
  | { state: "unavailable"; reason: string };

export interface ServiceHealth {
  service: string;
  network: string;
  startedAt: string;
  chain: ChainState;
}

export interface HealthReport {
  service: string;
  status: "ok" | "unavailable";
  network: string;
  chain: ChainState;
  startedAt: string;
}

export function createServiceHealth(service: string, config: VeiloConfig, requiresChain: boolean): ServiceHealth {
  return {
    service,
    network: config.network.caip2,
    startedAt: new Date().toISOString(),
    chain: requiresChain ? { state: "pending" } : { state: "not_required" },
  };
}

/** A service is healthy only once chain identity is verified (or not required). */
export function healthReport(health: ServiceHealth): HealthReport {
  const ok = health.chain.state === "verified" || health.chain.state === "not_required";
  return {
    service: health.service,
    status: ok ? "ok" : "unavailable",
    network: health.network,
    chain: health.chain,
    startedAt: health.startedAt,
  };
}

export interface ChainGuardOptions {
  retryMs?: number;
  fetchImpl?: FetchLike;
  /** Called on a definitive network or mint mismatch; services exit instead of degrading. */
  onMismatch: (error: VeiloConfigError) => void;
}

/**
 * Verifies chain identity, retrying while the RPC is unreachable. A wrong network or mint
 * is terminal. Returns a function that stops further retries.
 */
export function startChainGuard(config: VeiloConfig, health: ServiceHealth, options: ChainGuardOptions): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const attempt = async () => {
    try {
      const identity = await verifyChainIdentity(config, options.fetchImpl);
      health.chain = { state: "verified", identity };
    } catch (error) {
      if (error instanceof VeiloConfigError && error.code !== "RPC_UNAVAILABLE") {
        health.chain = { state: "unavailable", reason: error.message };
        options.onMismatch(error);
        return;
      }
      health.chain = { state: "unavailable", reason: (error as Error).message };
      if (!stopped) timer = setTimeout(() => void attempt(), options.retryMs ?? 30_000);
    }
  };
  void attempt();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
