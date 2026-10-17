import type { FundingProvider } from "@veilo/contracts";
import type { Ledger } from "../context";
import { ExternalBatchRunner, type ExternalBatchDeps } from "../external/batch";
import { BridgeHirePort, LocalExternalPort, MarketplaceWorkflowPort } from "../workflows/adapters";
import { WorkflowRunner } from "../workflows/runner";
import { MarketplaceBridge, type ChainIdentity } from "../marketplace/bridge";
import type { MarketplaceClient } from "../marketplace/client";
import type { ControllerIdentity } from "../marketplace/controller-identity";
import type { SellerClients } from "../marketplace/seller-clients";
import { Scheduler } from "../scheduler/scheduler";
import type { GatewayClient } from "./gateway-client";
import { PurchaseOrchestrator } from "./orchestrator";
import type { PermitSigner } from "./permits";

export interface Integration {
  orchestrator: PurchaseOrchestrator;
  gateway: GatewayClient | undefined;
  scheduler: Scheduler;
  /** Present only when MARKETPLACE_URL is configured. */
  marketplace?: MarketplaceBridge | undefined;
  external?: ExternalBatchRunner | undefined;
  /** Present when both the marketplace and external purchases are configured. */
  workflows?: WorkflowRunner | undefined;
}

export interface MarketplaceIntegrationOptions {
  client: MarketplaceClient;
  identity: ControllerIdentity;
  sellers: SellerClients;
  chain: ChainIdentity;
  maxPaymentUnits: bigint;
  /** Seconds a marketplace quote must still have before the private proof is released. */
  minQuoteRemainingSeconds?: number;
  pollMs?: number;
}

export function createIntegration(
  ledger: Ledger,
  o: {
    gateway: GatewayClient | undefined;
    permits: PermitSigner | undefined;
    funding: FundingProvider;
    log?: (line: string) => void;
    leaseMs?: number;
    settleWaitMs?: number;
    settlePollMs?: number;
    purchaseSweepMs?: number;
    marketplace?: MarketplaceIntegrationOptions | undefined;
    external?: Pick<ExternalBatchDeps, "origins" | "timeoutMs"> | undefined;
    /** Ceilings for workflow runs and their external batches, in base units. */
    workflowLimits?: { maxRunUsdc: bigint; maxExternalBatchUsdc: bigint } | undefined;
  },
): Integration {
  const external = o.external ? new ExternalBatchRunner({ ledger, funding: o.funding, ...o.external }) : undefined;
  // The orchestrator's hooks reach the bridge, which is built from the orchestrator below.
  const bridgeRef: { current?: MarketplaceBridge } = {};
  const workflowRef: { current?: WorkflowRunner } = {};
  // Workflow external steps bind their payer first; marketplace hires use the bridge's gate.
  const beforeRelease = async (purchaseId: string) =>
    (await workflowRef.current?.beforeRelease(purchaseId)) ?? (await bridgeRef.current?.beforeRelease(purchaseId)) ?? { outcome: "ok" as const };
  const orchestrator = new PurchaseOrchestrator({
    ledger,
    gateway: o.gateway,
    permits: o.permits,
    funding: o.funding,
    external,
    beforeRelease,
    ...(o.marketplace ? { sellers: o.marketplace.sellers, onPayerKnown: (purchaseId: string, payer: string) => bridgeRef.current?.payerKnown(purchaseId, payer),
          beforeMerchant: (purchaseId: string) => bridgeRef.current?.beforeMerchant(purchaseId) ?? { outcome: "ok" as const },
        } : {}),
    ...(o.settleWaitMs !== undefined ? { settleWaitMs: o.settleWaitMs } : {}),
    ...(o.settlePollMs !== undefined ? { settlePollMs: o.settlePollMs } : {}),
  });
  const marketplace = o.marketplace
    ? new MarketplaceBridge({
        ledger,
        client: o.marketplace.client,
        identity: o.marketplace.identity,
        orchestrator,
        policy: o.marketplace.sellers.policy,
        chain: o.marketplace.chain,
        maxPaymentUnits: o.marketplace.maxPaymentUnits,
        ...(o.marketplace.minQuoteRemainingSeconds !== undefined ? { minQuoteRemainingMs: o.marketplace.minQuoteRemainingSeconds * 1000 } : {}),
        ...(o.log ? { log: o.log } : {}),
      })
    : undefined;
  if (marketplace) bridgeRef.current = marketplace;
  const workflows =
    marketplace && external
      ? new WorkflowRunner({
          ledger,
          market: new MarketplaceWorkflowPort(marketplace.deps.client),
          hires: new BridgeHirePort(marketplace, ledger),
          external: new LocalExternalPort(ledger, orchestrator, external, o.workflowLimits?.maxExternalBatchUsdc ?? 100_000n),
          maxRunUsdc: o.workflowLimits?.maxRunUsdc ?? 1_000_000n,
        })
      : undefined;
  if (workflows) workflowRef.current = workflows;
  const scheduler = new Scheduler({
    ledger,
    gateway: o.gateway,
    orchestrator,
    ...(marketplace ? { marketplace, marketplacePollMs: o.marketplace?.pollMs ?? 10_000 } : {}),
    workflows,
    ...(o.log ? { log: o.log } : {}),
    ...(o.leaseMs !== undefined ? { leaseMs: o.leaseMs } : {}),
    ...(o.purchaseSweepMs !== undefined ? { purchaseSweepMs: o.purchaseSweepMs } : {}),
  });
  return { orchestrator, gateway: o.gateway, scheduler, marketplace, external, workflows };
}
