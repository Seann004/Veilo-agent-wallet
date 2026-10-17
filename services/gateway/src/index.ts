import { existsSync, readFileSync } from "node:fs";
import { HTTPFacilitatorClient } from "@x402/core/http";
import {
  VeiloConfigError,
  createServiceHealth,
  describeConfig,
  findRepoRoot,
  isLoopbackUrl,
  loadConfig,
  loadDotEnv,
  startChainGuard,
  type VeiloConfig,
} from "@veilo/contracts";
import { loadGatewayConfig, loadUsagePermitPublicKey } from "@veilo/contracts/gateway";
import { createApp } from "./app";
import { hashToken } from "./auth";
import { createRpcChain } from "./chain";
import type { GatewayHooks } from "./context";
import { openGatewayDb } from "./db/database";
import { Gateway } from "./gateway";
import { OpenRouterProvider } from "./provider/openrouter";
import { DEFAULT_ACCOUNT_RATE_LIMIT } from "./seller-host/accounts";
import { CLAIM_RETRY_DELAYS_MS, gatewayRole, HEARTBEAT_MS, loadSellerHostConfig } from "./seller-host/config";
import { PROVIDER_NOT_CONFIGURED, providerAdaptersFromEnv, providerStatus } from "./seller-host/providers";
import { MarketplaceClient } from "./seller-host/marketplace-client";

const SERVICE = "gateway";
const REFRESH_MS = 5 * 60_000;
const SELLER_RECOVER_MS = 30_000;

function readSecretFile(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim();
}

/**
 * Integration-test wiring, honored only under the local-test-validator profile: a loopback
 * OpenRouter-compatible mock provider (labeled fixture) and named crash points that end the
 * process at a gateway hook, to test restart at that boundary.
 */
function localTestOptions(config: VeiloConfig): { providerUrl?: string; hooks?: GatewayHooks } {
  const providerUrl = process.env.GATEWAY_TEST_PROVIDER_URL?.trim() || undefined;
  const crash = (process.env.VEILO_TEST_CRASH_POINTS ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (!providerUrl && crash.length === 0) return {};
  if (config.network.profile !== "local-test-validator") {
    throw new VeiloConfigError("INVALID_CONFIG", "GATEWAY_TEST_PROVIDER_URL and VEILO_TEST_CRASH_POINTS require VEILO_CHAIN_PROFILE=local-test-validator");
  }
  if (providerUrl && !isLoopbackUrl(providerUrl)) throw new VeiloConfigError("INVALID_CONFIG", "GATEWAY_TEST_PROVIDER_URL must be a loopback URL");
  const point = (name: keyof GatewayHooks) =>
    crash.includes(`gateway.${name}`)
      ? () => {
          console.error(`[${SERVICE}] crash point gateway.${name} reached; exiting`);
          process.exit(86);
        }
      : undefined;
  const hooks: GatewayHooks = {};
  for (const name of ["afterClaim", "afterPaymentFinalized", "beforeProviderCall"] as const) {
    const fn = point(name);
    if (fn) hooks[name] = fn;
  }
  return { ...(providerUrl ? { providerUrl: providerUrl.replace(/\/$/, "") } : {}), ...(crash.length > 0 ? { hooks } : {}) };
}

async function main(): Promise<void> {
  const rootDir = findRepoRoot();
  loadDotEnv({ allowProviderSecrets: true });
  const config = loadConfig(process.env, { rootDir });
  const gw = loadGatewayConfig(config, process.env, { rootDir });
  const role = gatewayRole(process.env);
  const host = role === "seller-host" ? loadSellerHostConfig(config, gw, process.env, { rootDir }) : undefined;
  const label = host ? `${SERVICE}:seller-host` : SERVICE;
  const health = createServiceHealth(SERVICE, config, true);
  startChainGuard(config, health, {
    onMismatch: (error) => {
      console.error(`[${SERVICE}] chain identity check failed (${error.code}): ${error.message}`);
      process.exit(1);
    },
  });

  const db = openGatewayDb(host ? host.databasePath : config.paths.gatewayDatabase);
  // Prepaid permits and sponsored planning belong to the operator gateway only.
  const permitPem = host ? undefined : readSecretFile(gw.usagePermitPublicKeyPath);
  const planningToken = host ? undefined : readSecretFile(gw.planningCredentialPath);
  const apiKey = config.openRouterApiKey;
  const local = localTestOptions(config);
  const provider = local.providerUrl
    ? config.inference.operatorMaxRealUsdMicro > 0n
      ? new OpenRouterProvider("local-mock-provider", fetch, local.providerUrl, "fixture")
      : null
    : config.inference.realInferenceEnabled && apiKey
      ? new OpenRouterProvider(apiKey)
      : null;
  if (local.providerUrl) console.log(`[${SERVICE}] FIXTURE provider: local OpenRouter-compatible mock (not real inference)`);

  // Provider keys are read only in the seller-host role and stay in this process.
  const providers = host ? providerAdaptersFromEnv(process.env) : undefined;
  if (providers) {
    for (const s of providerStatus(providers)) console.log(`[${SERVICE}] provider ${s.provider}: ${s.status === "configured" ? "configured" : PROVIDER_NOT_CONFIGURED}`);
  }
  const gateway = new Gateway({
    db,
    settings: {
      role,
      identity: host ? host.identity : gw.identity,
      origin: host ? host.publicOrigin : gw.publicOrigin,
      network: config.network.caip2,
      genesisHash: config.network.genesisHash,
      mint: config.network.mint,
      mintDecimals: config.network.mintDecimals,
      facilitatorUrl: config.network.facilitatorUrl,
      merchantAddress: host ? undefined : gw.merchantAddress,
      merchantAta: host ? undefined : gw.merchantAta,
      feePayer: gw.facilitatorFeePayer,
      quoteTtlSeconds: gw.quoteTtlSeconds,
      settlementWaitMs: gw.settlementWaitMs,
      settlementPollMs: 2_000,
      maxTimeoutSeconds: 300,
      operatorCeilingMicro: config.inference.operatorMaxRealUsdMicro,
      sellerHost: host
        ? { allowedRecipients: host.allowedRecipients, heartbeatMs: HEARTBEAT_MS, claimRetryDelaysMs: CLAIM_RETRY_DELAYS_MS }
        : undefined,
    },
    chain: createRpcChain(config.network.rpcUrl),
    facilitator: new HTTPFacilitatorClient({ url: config.network.facilitatorUrl, timeoutMs: 60_000 }),
    provider,
    providerDisabledReason: provider ? undefined : "real inference disabled (provider key or OPERATOR_MAX_REAL_USD_MICRO missing)",
    inferenceModelId: config.inference.inferenceModelId,
    plannerModelId: config.inference.plannerModelId,
    pricingMaxAgeSeconds: gw.pricingMaxAgeSeconds,
    providerTimeoutMs: gw.providerTimeoutMs,
    ...(local.providerUrl ? { pricingFetch: (_url: string, init?: RequestInit) => fetch(`${local.providerUrl}/models`, init) } : {}),
    ...(permitPem ? { permitPublicKey: loadUsagePermitPublicKey(permitPem) } : {}),
    ...(planningToken ? { planningTokenHash: hashToken(planningToken) } : {}),
    ...(provider ? { providerKeyCheck: () => provider.keyLimitRemainingMicro(AbortSignal.timeout(15_000)) } : {}),
    ...(local.hooks ? { hooks: local.hooks } : {}),
    ...(host ? { marketplace: new MarketplaceClient({ baseUrl: host.marketplaceUrl, token: host.marketplaceToken }) } : {}),
    ...(providers ? { providers } : {}),
    serviceHealth: health,
  });

  await gateway.recover();
  await gateway.refreshExternal();
  setInterval(() => void gateway.refreshExternal(), REFRESH_MS).unref();
  if (host && providers) {
    // The marketplace disables a tool whose reviewed manifest differs from what this host runs.
    const reportTools = async () => {
      for (const s of providerStatus(providers)) {
        await gateway.ctx.marketplace?.toolStatus({ provider: s.provider, manifestSha256: s.manifestSha256, configured: s.status === "configured" }).catch(() => undefined);
      }
    };
    void reportTools();
    setInterval(() => void reportTools(), REFRESH_MS).unref();
  }
  if (host) {
    // Paid jobs keep moving (claim, run, report) even when no buyer is polling for the result.
    let passing = false;
    setInterval(() => {
      if (passing) return;
      passing = true;
      gateway.purchases
        .recover()
        .catch((error: unknown) => console.error(`[${label}] fulfilment pass failed: ${(error as Error).name}`))
        .finally(() => {
          passing = false;
        });
    }, SELLER_RECOVER_MS).unref();
  }

  const port = host ? host.port : config.ports.gateway;
  const appOptions = host ? { accountRateLimit: { ...DEFAULT_ACCOUNT_RATE_LIMIT, perIp: host.accountsPerIpHour } } : {};
  createApp(gateway, appOptions).listen(port, config.bindHost, () => {
    console.log(`[${label}] listening on http://${config.bindHost}:${port} (${config.network.caip2})`);
  });
  if (process.env.VEILO_LOG_CONFIG === "1") console.log(JSON.stringify(describeConfig(config)));
}

main().catch((error: unknown) => {
  if (error instanceof VeiloConfigError) {
    console.error(`[${SERVICE}] configuration rejected (${error.code}): ${error.message}`);
  } else {
    console.error(`[${SERVICE}] startup failed: ${(error as Error).message}`);
  }
  process.exit(1);
});
