import type { VeiloConfig } from "../config";

/**
 * Configuration visible to the agent runner. It carries no database paths, secrets directory,
 * signer/sponsor key paths, provider key or other services' credential paths, so the runner
 * process cannot locate the wallet secrets database or provider credentials through config.
 * The runner reaches the ledger only through the control API with its worker credential.
 */
export interface RunnerConfig {
  network: { caip2: string; mint: string; mintDecimals: number };
  controlUrl: string;
  workerCredentialPath: string | undefined;
  plannerModelId: string | undefined;
  bindHost: string;
  port: number;
}

export function toRunnerConfig(config: VeiloConfig): RunnerConfig {
  return {
    network: {
      caip2: config.network.caip2,
      mint: config.network.mint,
      mintDecimals: config.network.mintDecimals,
    },
    controlUrl: `http://${config.bindHost}:${config.ports.control}`,
    workerCredentialPath: config.paths.serviceCredentials.runner,
    plannerModelId: config.inference.plannerModelId,
    bindHost: config.bindHost,
    port: config.ports.runner,
  };
}

/** Environment variables the runner process must not receive. */
export const RUNNER_WITHHELD_ENV = [
  "OPENROUTER_API_KEY",
  "SPONSOR_KEY_PATH",
  "FUNDING_KEY_PATH",
  "OWNER_SERVICE_SECRET_PATH",
  "CONTROL_SERVICE_CREDENTIAL_PATH",
  "WALLET_SERVICE_CREDENTIAL_PATH",
  "GATEWAY_ADMIN_CREDENTIAL_PATH",
  "RELAYER_SERVICE_CREDENTIAL_PATH",
  "CONTROL_DATABASE_PATH",
  "GATEWAY_DATABASE_PATH",
  "VEILO_SECRETS_DIR",
] as const;
