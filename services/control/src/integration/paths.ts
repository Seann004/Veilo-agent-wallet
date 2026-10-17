import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { VeiloConfig } from "@veilo/contracts";

export interface IntegrationPaths {
  /** Control-only: Ed25519 private key (PKCS#8 PEM) that signs usage permits. */
  permitPrivateKey: string;
  /** Gateway-only: matching public key. */
  permitPublicKey: string;
  /** Control-only: bearer token of the workspace's gateway credit account. */
  gatewayAccountToken: string;
  /** Shared by gateway (hash) and control (bearer) for sponsored planning. */
  planningToken: string;
  /** Runner-only: per-agent worker tokens. */
  runnerCredentials: string;
  /** Control-only: Ed25519 marketplace controller key (PKCS#8 PEM, 0600). */
  controllerKey: string;
  /** Control-only: directory of per-seller-host account tokens (0700, files 0600). */
  sellerAccountsDir: string;
}

const abs = (rootDir: string, p: string) => (isAbsolute(p) ? p : resolve(rootDir, p));

/** Secret file locations; explicit environment paths override the secrets-directory defaults. */
export function integrationPaths(config: VeiloConfig, env: Record<string, string | undefined> = process.env, rootDir = process.cwd()): IntegrationPaths {
  const pick = (name: string, fallback: string) => {
    const v = env[name]?.trim();
    return v ? abs(rootDir, v) : fallback;
  };
  const s = config.paths.secretsDir;
  return {
    permitPrivateKey: pick("CONTROL_USAGE_PERMIT_KEY_PATH", join(s, "control", "usage-permit-signing.pem")),
    permitPublicKey: pick("USAGE_PERMIT_PUBLIC_KEY_PATH", join(s, "gateway", "usage-permit-public.pem")),
    gatewayAccountToken: pick("CONTROL_GATEWAY_ACCOUNT_TOKEN_PATH", join(s, "control", "gateway-account.token")),
    planningToken: pick("GATEWAY_PLANNING_CREDENTIAL_PATH", join(s, "gateway", "planning.token")),
    runnerCredentials: config.paths.serviceCredentials.runner ?? join(s, "runner", "worker-credentials.json"),
    controllerKey: pick("CONTROL_CONTROLLER_KEY_PATH", join(s, "control", "marketplace-controller.pem")),
    sellerAccountsDir: pick("CONTROL_SELLER_ACCOUNTS_DIR", join(s, "control", "seller-accounts")),
  };
}

/** Reads a secret file's trimmed contents; never logs them. */
export function readSecret(path: string | undefined): string | undefined {
  if (path === undefined || !existsSync(path)) return undefined;
  const v = readFileSync(path, "utf8").trim();
  return v === "" ? undefined : v;
}
