import {
  RUNNER_WITHHELD_ENV,
  VeiloConfigError,
  createServiceHealth,
  loadConfig,
  findRepoRoot,
  loadDotEnv,
  toRunnerConfig,
} from "@veilo/contracts";
import { existsSync, readFileSync } from "node:fs";
import { createApp } from "./app";
import { startWorker, type AgentCredential } from "./worker";

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

  const creds = loadCredentials(runnerConfig.workerCredentialPath);
  if (creds.length === 0) {
    console.log(`[${SERVICE}] no worker credentials configured; run pnpm demo:seed. Research and content jobs stay queued`);
    return;
  }
  const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  startWorker(creds, {
    controlUrl: runnerConfig.controlUrl,
    workerId: `runner-${process.pid}`,
    fetchPolicy: {
      approvedOrigins: list(process.env.RUNNER_APPROVED_FETCH_ORIGINS),
      localServiceOrigins: list(process.env.RUNNER_LOCAL_SERVICE_ORIGINS),
    },
  });
  console.log(`[${SERVICE}] worker started for ${creds.map((c) => c.role).join(", ")}`);
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

/** Worker credential file written by demo:seed: {"agents":[{"agentId","role","token"}]}. Tokens are never logged. */
function loadCredentials(path: string | undefined): AgentCredential[] {
  if (!path || !existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { agents?: Array<Partial<AgentCredential>> };
  return (parsed.agents ?? []).filter(
    (a): a is AgentCredential => typeof a.agentId === "string" && typeof a.token === "string" && (a.role === "research" || a.role === "content" || a.role === "custom"),
  );
}
