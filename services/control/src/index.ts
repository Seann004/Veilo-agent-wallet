import { isAddress } from "@solana/kit";
import {
  VeiloConfigError,
  createServiceHealth,
  describeConfig,
  findRepoRoot,
  loadConfig,
  loadDotEnv,
  startChainGuard,
} from "@veilo/contracts";
import { MARKETPLACE_LIMITS } from "@veilo/contracts/marketplace";
import { openControlDatabase } from "@veilo/db";
import { McpClient } from "@veilo/mcp-client";
import { createApp } from "./app";
import { ServiceCredentials } from "./auth/credentials";
import type { SessionSettings } from "./auth/session";
import { parseGuestPubkeys, parseGuestRunsPerHour, parsePublicView } from "./auth/access-config";
import { AgentConnectors, connectorLimitsFromEnv, parseConnectorCatalog } from "./connectors/agent-connectors";
import { createLedger } from "./context";
import { createIntegration } from "./integration";
import { UnavailableFundingProvider, WalletFundingProvider } from "./integration/funding";
import { GatewayClient } from "./integration/gateway-client";
import { integrationPaths, readSecret } from "./integration/paths";
import { PermitSigner } from "./integration/permits";
import { MarketplaceClient, marketplaceUrlProblem } from "./marketplace/client";
import { ControllerIdentity } from "./marketplace/controller-identity";
import { SellerOriginPolicy } from "./marketplace/origin-policy";
import { SellerClients } from "./marketplace/seller-clients";
import { expireLeases } from "./ledger/jobs";
import { seedWorkspace } from "./ledger/workspace";

const SERVICE = "control";

async function main(): Promise<void> {
  const rootDir = findRepoRoot();
  loadDotEnv({});
  const config = loadConfig(process.env, { rootDir });
  const health = createServiceHealth(SERVICE, config, true);
  startChainGuard(config, health, {
    onMismatch: (error) => {
      console.error(`[${SERVICE}] chain identity check failed (${error.code}): ${error.message}`);
      process.exit(1);
    },
  });

  const db = openControlDatabase(config.paths.controlDatabase, { secretsDir: config.paths.secretsDir });
  const ledger = createLedger(db);
  const reconciling = expireLeases(ledger);
  if (reconciling.length > 0) console.log(`[${SERVICE}] ${reconciling.length} expired job lease(s) moved to reconciliation`);

  const ownerPubkey = process.env.VEILO_OWNER_PUBKEY?.trim();
  if (ownerPubkey) {
    if (!isAddress(ownerPubkey)) throw new VeiloConfigError("INVALID_CONFIG", "VEILO_OWNER_PUBKEY: must be a base58 Solana address");
    const { created } = seedWorkspace(ledger, {
      ownerPubkey,
      network: config.network.caip2,
      mint: config.network.mint,
      mintDecimals: config.network.mintDecimals,
    });
    console.log(`[${SERVICE}] workspace ${created ? "seeded with draft default policies" : "already initialized"}`);
  } else {
    console.log(`[${SERVICE}] VEILO_OWNER_PUBKEY is unset; owner login is unavailable until a workspace is seeded`);
  }

  const guestPubkeys = parseGuestPubkeys(process.env.VEILO_GUEST_PUBKEYS, ownerPubkey);
  const publicView = parsePublicView(process.env.VEILO_PUBLIC_VIEW);
  const guestRunsPerHour = parseGuestRunsPerHour(process.env.VEILO_GUEST_RUNS_PER_HOUR);
  if (guestPubkeys.length > 0) console.log(`[${SERVICE}] ${guestPubkeys.length} guest wallet(s) may sign in (${guestRunsPerHour} runs per hour each)`);
  if (publicView) console.log(`[${SERVICE}] public read-only view is enabled`);

  const dashboardOrigin = process.env.VEILO_DASHBOARD_ORIGIN?.trim() || `http://localhost:${config.ports.dashboard}`;
  const session: SessionSettings = {
    domain: new URL(dashboardOrigin).host,
    origin: new URL(dashboardOrigin).origin,
    chainId: config.network.caip2,
    challengeTtlMs: 5 * 60_000,
    sessionTtlMs: 12 * 3_600_000,
    secureCookies: dashboardOrigin.startsWith("https:"),
    guestPubkeys,
    publicView,
    guestRunsPerHour,
  };
  const services = ServiceCredentials.fromFiles(
    { wallet: config.paths.serviceCredentials.wallet, relayer: config.paths.serviceCredentials.relayer },
    (msg) => console.log(`[${SERVICE}] ${msg}`),
  );

  const paths = integrationPaths(config, process.env, rootDir);
  const accountToken = readSecret(paths.gatewayAccountToken);
  const gateway = accountToken
    ? new GatewayClient({
        baseUrl: `http://${config.bindHost}:${config.ports.gateway}`,
        accountToken,
        planningToken: readSecret(paths.planningToken),
        identity: process.env.GATEWAY_IDENTITY?.trim() || "veilo-gateway-devnet",
      })
    : undefined;
  if (!gateway) console.log(`[${SERVICE}] gateway account token not found; run pnpm demo:seed. Purchases stay authorization-only`);
  const permits = PermitSigner.fromFile(paths.permitPrivateKey);
  if (!permits) console.log(`[${SERVICE}] usage permit signing key not found; prepaid usage is unavailable`);
  const walletToken = readSecret(config.paths.serviceCredentials.control);
  const funding = walletToken
    ? new WalletFundingProvider({ baseUrl: `http://${config.bindHost}:${config.ports.wallet}`, serviceToken: walletToken })
    : new UnavailableFundingProvider("CONTROL_SERVICE_CREDENTIAL_PATH is not configured; private funding is unavailable");
  console.log(`[${SERVICE}] private funding provider: ${funding.mode}`);
  const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  const msEnv = (name: string, fallback: number) => {
    const v = Number(process.env[name] ?? fallback);
    return Number.isInteger(v) && v >= 0 ? v : fallback;
  };
  const marketplaceUrl = process.env.MARKETPLACE_URL?.trim();
  let marketplace: Parameters<typeof createIntegration>[1]["marketplace"];
  if (marketplaceUrl) {
    const problem = marketplaceUrlProblem(marketplaceUrl);
    if (problem) throw new VeiloConfigError("INVALID_CONFIG", problem);
    const secondsEnv = (name: string, fallback: number) => {
      const raw = process.env[name]?.trim();
      if (!raw) return fallback;
      if (!/^[0-9]{1,5}$/.test(raw)) throw new VeiloConfigError("INVALID_CONFIG", `${name} must be a whole number of seconds`);
      return Number(raw);
    };
    const maxRaw = process.env.MARKETPLACE_MAX_PAYMENT_UNITS?.trim() || "1000000";
    if (!/^[1-9][0-9]{0,18}$/.test(maxRaw)) throw new VeiloConfigError("INVALID_CONFIG", "MARKETPLACE_MAX_PAYMENT_UNITS must be a positive integer of base units");
    const identity = ControllerIdentity.loadOrCreate(paths.controllerKey);
    const policy = new SellerOriginPolicy({ localTestOrigins: list(process.env.MARKETPLACE_LOCAL_SELLER_ORIGINS) });
    marketplace = {
      client: new MarketplaceClient({ baseUrl: marketplaceUrl, identity }),
      identity,
      sellers: new SellerClients({ policy, tokenDir: paths.sellerAccountsDir }),
      chain: { network: config.network.caip2, genesisHash: config.network.genesisHash, mint: config.network.mint, decimals: config.network.mintDecimals },
      maxPaymentUnits: BigInt(maxRaw),
      minQuoteRemainingSeconds: secondsEnv("MARKETPLACE_MIN_QUOTE_REMAINING_SECONDS", MARKETPLACE_LIMITS.minQuoteRemainingSeconds),
      pollMs: msEnv("MARKETPLACE_POLL_MS", 10_000),
    };
    console.log(`[${SERVICE}] marketplace controller ${identity.keyId} polls ${new URL(marketplaceUrl).origin}`);
  } else {
    console.log(`[${SERVICE}] MARKETPLACE_URL is unset; marketplace hires are disabled`);
  }
  const externalMaxRaw = process.env.EXTERNAL_X402_MAX_BATCH_UNITS?.trim() || "100000";
  if (!/^[1-9][0-9]{0,18}$/.test(externalMaxRaw)) throw new VeiloConfigError("INVALID_CONFIG", "EXTERNAL_X402_MAX_BATCH_UNITS must be a positive integer of base units");
  const workflowMaxRaw = process.env.WORKFLOW_MAX_RUN_UNITS?.trim() || "1000000";
  if (!/^[1-9][0-9]{0,18}$/.test(workflowMaxRaw)) throw new VeiloConfigError("INVALID_CONFIG", "WORKFLOW_MAX_RUN_UNITS must be a positive integer of base units");
  const integration = createIntegration(ledger, {
    gateway,
    permits,
    funding,
    marketplace,
    external: { origins: new SellerOriginPolicy({ localTestOrigins: list(process.env.EXTERNAL_X402_LOCAL_ORIGINS) }) },
    workflowLimits: { maxRunUsdc: BigInt(workflowMaxRaw), maxExternalBatchUsdc: BigInt(externalMaxRaw) },
    log: (l) => console.log(`[${SERVICE}] ${l}`),
    settleWaitMs: msEnv("CONTROL_PURCHASE_WAIT_MS", 120_000),
    purchaseSweepMs: msEnv("CONTROL_PURCHASE_SWEEP_MS", 15_000),
  });
  // Startup reconciles existing operations before any new job starts.
  await integration.scheduler.reconcileExpired();
  await integration.orchestrator.reconcileAll();
  integration.scheduler.start();

  let connectorLimits: ReturnType<typeof connectorLimitsFromEnv>;
  try {
    connectorLimits = connectorLimitsFromEnv(process.env);
  } catch (error) {
    throw new VeiloConfigError("INVALID_CONFIG", (error as Error).message);
  }
  const catalogClient = marketplace?.client;
  const connectors = new AgentConnectors({
    ledger,
    catalog: catalogClient
      ? async () => {
          const r = await catalogClient.publicGet("/marketplace/connectors");
          if (r.status !== 200) throw new Error(`marketplace connectors returned HTTP ${r.status}`);
          return parseConnectorCatalog(r.body);
        }
      : undefined,
    client: (endpoint) => new McpClient(endpoint, { publicOnly: true, timeoutMs: msEnv("CONNECTOR_CALL_TIMEOUT_MS", 20_000), maxBytes: 1_048_576, clientName: "veilo-control" }),
    limits: connectorLimits,
    log: (l) => console.log(`[${SERVICE}] ${l}`),
  });

  const port = config.ports.control;
  createApp(health, { ledger, session, services, integration, connectors, maxExternalBatchUsdc: BigInt(externalMaxRaw) }).listen(port, config.bindHost, () => {
    console.log(`[${SERVICE}] listening on http://${config.bindHost}:${port} (${config.network.caip2})`);
  });
  if (process.env.VEILO_LOG_CONFIG === "1") console.log(JSON.stringify(describeConfig(config)));
}

main().catch((error: unknown) => {
  if (error instanceof VeiloConfigError) {
    console.error(`[${SERVICE}] configuration rejected (${error.code}): ${error.message}`);
    process.exit(1);
  }
  console.error(`[${SERVICE}] startup failed: ${(error as Error).name}: ${(error as Error).message}`);
  process.exit(1);
});
