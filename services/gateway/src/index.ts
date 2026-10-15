import { existsSync, readFileSync } from "node:fs";
import { HTTPFacilitatorClient } from "@x402/core/http";
import {
  VeiloConfigError,
  createServiceHealth,
  describeConfig,
  findRepoRoot,
  loadConfig,
  loadDotEnv,
  startChainGuard,
} from "@veilo/contracts";
import { loadGatewayConfig, loadUsagePermitPublicKey } from "@veilo/contracts/gateway";
import { createApp } from "./app";
import { hashToken } from "./auth";
import { createRpcChain } from "./chain";
import { openGatewayDb } from "./db/database";
import { Gateway } from "./gateway";
import { OpenRouterProvider } from "./provider/openrouter";

const SERVICE = "gateway";
const REFRESH_MS = 5 * 60_000;

function readSecretFile(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim();
}

async function main(): Promise<void> {
  const rootDir = findRepoRoot();
  loadDotEnv({ allowProviderSecrets: true });
  const config = loadConfig(process.env, { rootDir });
  const gw = loadGatewayConfig(config, process.env, { rootDir });
  const health = createServiceHealth(SERVICE, config, true);
  startChainGuard(config, health, {
    onMismatch: (error) => {
      console.error(`[${SERVICE}] chain identity check failed (${error.code}): ${error.message}`);
      process.exit(1);
    },
  });

  const db = openGatewayDb(config.paths.gatewayDatabase);
  const permitPem = readSecretFile(gw.usagePermitPublicKeyPath);
  const planningToken = readSecretFile(gw.planningCredentialPath);
  const apiKey = config.openRouterApiKey;
  const provider = config.inference.realInferenceEnabled && apiKey ? new OpenRouterProvider(apiKey) : null;

  const gateway = new Gateway({
    db,
    settings: {
      identity: gw.identity,
      origin: gw.publicOrigin,
      network: config.network.caip2,
      mint: config.network.mint,
      facilitatorUrl: config.network.facilitatorUrl,
      merchantAddress: gw.merchantAddress,
      merchantAta: gw.merchantAta,
      feePayer: gw.facilitatorFeePayer,
      quoteTtlSeconds: gw.quoteTtlSeconds,
      settlementWaitMs: gw.settlementWaitMs,
      settlementPollMs: 2_000,
      maxTimeoutSeconds: 300,
      operatorCeilingMicro: config.inference.operatorMaxRealUsdMicro,
    },
    chain: createRpcChain(config.network.rpcUrl),
    facilitator: new HTTPFacilitatorClient({ url: config.network.facilitatorUrl, timeoutMs: 60_000 }),
    provider,
    providerDisabledReason: provider ? undefined : "real inference disabled (provider key or OPERATOR_MAX_REAL_USD_MICRO missing)",
    inferenceModelId: config.inference.inferenceModelId,
    plannerModelId: config.inference.plannerModelId,
    pricingMaxAgeSeconds: gw.pricingMaxAgeSeconds,
    providerTimeoutMs: gw.providerTimeoutMs,
    ...(permitPem ? { permitPublicKey: loadUsagePermitPublicKey(permitPem) } : {}),
    ...(planningToken ? { planningTokenHash: hashToken(planningToken) } : {}),
    ...(provider ? { providerKeyCheck: () => provider.keyLimitRemainingMicro(AbortSignal.timeout(15_000)) } : {}),
    serviceHealth: health,
  });

  await gateway.recover();
  await gateway.refreshExternal();
  setInterval(() => void gateway.refreshExternal(), REFRESH_MS).unref();

  const port = config.ports.gateway;
  createApp(gateway).listen(port, config.bindHost, () => {
    console.log(`[${SERVICE}] listening on http://${config.bindHost}:${port} (${config.network.caip2})`);
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
