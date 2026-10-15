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
import { openControlDatabase } from "@veilo/db";
import { createApp } from "./app";
import { ServiceCredentials } from "./auth/credentials";
import type { SessionSettings } from "./auth/session";
import { createLedger } from "./context";
import { expireLeases } from "./ledger/jobs";
import { seedWorkspace } from "./ledger/workspace";

const SERVICE = "control";

function main(): void {
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

  const dashboardOrigin = process.env.VEILO_DASHBOARD_ORIGIN?.trim() || `http://localhost:${config.ports.dashboard}`;
  const session: SessionSettings = {
    domain: new URL(dashboardOrigin).host,
    origin: new URL(dashboardOrigin).origin,
    chainId: config.network.caip2,
    challengeTtlMs: 5 * 60_000,
    sessionTtlMs: 12 * 3_600_000,
    secureCookies: dashboardOrigin.startsWith("https:"),
  };
  const services = ServiceCredentials.fromFiles(
    { wallet: config.paths.serviceCredentials.wallet, relayer: config.paths.serviceCredentials.relayer },
    (msg) => console.log(`[${SERVICE}] ${msg}`),
  );

  const port = config.ports.control;
  createApp(health, { ledger, session, services }).listen(port, config.bindHost, () => {
    console.log(`[${SERVICE}] listening on http://${config.bindHost}:${port} (${config.network.caip2})`);
  });
  if (process.env.VEILO_LOG_CONFIG === "1") console.log(JSON.stringify(describeConfig(config)));
}

try {
  main();
} catch (error) {
  if (error instanceof VeiloConfigError) {
    console.error(`[${SERVICE}] configuration rejected (${error.code}): ${error.message}`);
    process.exit(1);
  }
  throw error;
}
