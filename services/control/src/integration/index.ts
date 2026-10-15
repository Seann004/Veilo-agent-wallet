import type { FundingProvider } from "@veilo/contracts";
import type { Ledger } from "../context";
import { Scheduler } from "../scheduler/scheduler";
import type { GatewayClient } from "./gateway-client";
import { PurchaseOrchestrator } from "./orchestrator";
import type { PermitSigner } from "./permits";

export interface Integration {
  orchestrator: PurchaseOrchestrator;
  gateway: GatewayClient | undefined;
  scheduler: Scheduler;
}

export function createIntegration(
  ledger: Ledger,
  o: { gateway: GatewayClient | undefined; permits: PermitSigner | undefined; funding: FundingProvider; log?: (line: string) => void; leaseMs?: number },
): Integration {
  const orchestrator = new PurchaseOrchestrator({ ledger, gateway: o.gateway, permits: o.permits, funding: o.funding });
  const scheduler = new Scheduler({
    ledger,
    gateway: o.gateway,
    orchestrator,
    ...(o.log ? { log: o.log } : {}),
    ...(o.leaseMs !== undefined ? { leaseMs: o.leaseMs } : {}),
  });
  return { orchestrator, gateway: o.gateway, scheduler };
}
