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
