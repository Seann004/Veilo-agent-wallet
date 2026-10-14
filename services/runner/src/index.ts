import {
  VeiloConfigError,
  createServiceHealth,
  describeConfig,
  loadConfig,
  findRepoRoot,
  loadDotEnv,
} from "@veilo/contracts";
import { createApp } from "./app";

// Workers never receive signer, owner-secret or other services' credential locations.
const RUNNER_WITHHELD_VARS = [
  "SPONSOR_KEY_PATH",
  "OWNER_SERVICE_SECRET_PATH",
  "CONTROL_SERVICE_CREDENTIAL_PATH",
  "WALLET_SERVICE_CREDENTIAL_PATH",
  "GATEWAY_ADMIN_CREDENTIAL_PATH",
  "RELAYER_SERVICE_CREDENTIAL_PATH",
];

const SERVICE = "runner";

function main(): void {
  loadDotEnv({ omit: RUNNER_WITHHELD_VARS });
  const config = loadConfig(process.env, { rootDir: findRepoRoot() });
  const health = createServiceHealth(SERVICE, config, false);
  const port = config.ports.runner;
  createApp(health).listen(port, config.bindHost, () => {
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
