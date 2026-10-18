import {
  RUNNER_WITHHELD_ENV,
  VeiloConfigError,
  createServiceHealth,
  loadConfig,
  findRepoRoot,
  loadDotEnv,
  toRunnerConfig,
} from "@veilo/contracts";
import { createApp } from "./app";
import { startWorker } from "./worker";
import { CredentialWatcher } from "./credentials";
import { ChromeReader } from "./browser";

const SERVICE = "runner";

function main(): void {
  // Workers never receive database, secrets-directory, signer, provider or other services' credential locations.
  loadDotEnv({ omit: RUNNER_WITHHELD_ENV });
  const config = loadConfig(process.env, { rootDir: findRepoRoot() });
  const health = createServiceHealth(SERVICE, config, false);
  const runnerConfig = toRunnerConfig(config);
  const port = runnerConfig.port;
  createApp(health).listen(port, runnerConfig.bindHost, () => {
    console.log(`[${SERVICE}] listening on http://${runnerConfig.bindHost}:${port} (${runnerConfig.network.caip2})`);
  });
  if (process.env.VEILO_LOG_CONFIG === "1") console.log(JSON.stringify(runnerConfig));

  const watcher = new CredentialWatcher(runnerConfig.workerCredentialPath, (l) => console.log(`[${SERVICE}] ${l}`));
  watcher.start(5_000);
  if (watcher.current().length === 0) {
    console.log(`[${SERVICE}] no worker credentials yet; run pnpm demo:seed or enable control provisioning. Agent jobs stay queued until one appears`);
  }
  const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  startWorker(() => watcher.current(), {
    controlUrl: runnerConfig.controlUrl,
    workerId: `runner-${process.pid}`,
    fetchPolicy: {
      approvedOrigins: list(process.env.RUNNER_APPROVED_FETCH_ORIGINS),
      localServiceOrigins: list(process.env.RUNNER_LOCAL_SERVICE_ORIGINS),
    },
    // Uses an installed Chrome; RUNNER_BROWSER=off disables browsing for every agent.
    ...(process.env.RUNNER_BROWSER === "off" ? {} : { browser: new ChromeReader({ executablePath: process.env.RUNNER_BROWSER_EXECUTABLE?.trim() || undefined }) }),
  });
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
