import {
  VeiloConfigError,
  createServiceHealth,
  describeConfig,
  findRepoRoot,
  loadConfig,
  loadDotEnv,
  startChainGuard,
} from "@veilo/contracts";
import { createApp } from "./app";
import { reconcileOnStartup } from "./reconcile";
import { createWalletRuntime } from "./runtime";

const SERVICE = "wallet";

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
  let rt;
  try {
    rt = await createWalletRuntime(config, process.env, rootDir);
  } catch (error) {
    if (!(error instanceof VeiloConfigError) && (error as Error).name !== "SecretError") throw error;
    // Without its secret or credentials the wallet serves only /health; no wallet API is exposed.
    console.error(`[${SERVICE}] wallet API disabled: ${(error as Error).message}`);
    createApp(health).listen(config.ports.wallet, config.bindHost);
    return;
  }
  let ready = false;
  const dashboardOrigin = process.env.VEILO_DASHBOARD_ORIGIN?.trim() || `http://localhost:${config.ports.dashboard}`;
  const app = createApp(health, {
    funding: rt.funding,
    notes: rt.notes,
    owner: rt.owner,
    control: rt.deps.control,
    controlCredentialDigest: rt.controlCredentialDigest,
    dashboardOrigin: new URL(dashboardOrigin).origin,
    isReady: () => ready,
  });
  const port = config.ports.wallet;
  app.listen(port, config.bindHost, () => {
    console.log(`[${SERVICE}] listening on http://${config.bindHost}:${port} (${config.network.caip2})`);
  });
  if (process.env.VEILO_LOG_CONFIG === "1") console.log(JSON.stringify(describeConfig(config)));

  // New funding work waits for reconciliation of every existing multi-leg operation.
  const attempt = async () => {
    try {
      const report = await reconcileOnStartup(rt!.deps, rt!);
      console.log(`[${SERVICE}] startup reconciliation: ${report.mismatches.length} mismatch(es), ready=${report.ready}`);
      for (const m of report.mismatches) console.log(`[${SERVICE}]   ${m}`);
      ready = report.ready;
      if (!ready) setTimeout(attempt, 30_000);
    } catch (error) {
      console.error(`[${SERVICE}] startup reconciliation incomplete (${(error as Error).name}); retrying`);
      setTimeout(attempt, 15_000);
    }
  };
  void attempt();
}

main().catch((error: unknown) => {
  if (error instanceof VeiloConfigError) {
    console.error(`[${SERVICE}] configuration rejected (${error.code}): ${error.message}`);
    process.exit(1);
  }
  console.error(`[${SERVICE}] failed to start: ${(error as Error).name}: ${(error as Error).message}`);
  process.exit(1);
});
