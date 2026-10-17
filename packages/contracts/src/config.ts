import { isAbsolute, resolve } from "node:path";
import { isAddress } from "@solana/kit";
import { z } from "zod";
import { VeiloConfigError } from "./errors";
import {
  DEMO_TOKEN_DECIMALS,
  DEMO_TOKEN_MINT,
  DEVNET_CAIP2,
  DEVNET_GENESIS_HASH,
  isMainnetIdentifier,
} from "./network";

export const SERVICE_NAMES = ["dashboard", "control", "runner", "wallet", "gateway", "relayer"] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

const DEFAULT_PORTS: Record<ServiceName, number> = {
  dashboard: 3000,
  control: 4101,
  runner: 4102,
  wallet: 4103,
  gateway: 4104,
  relayer: 4105,
};

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());

const optionalAddress = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .refine((v) => isAddress(v), "must be a base58 Solana address")
    .optional(),
);

const port = (fallback: number) =>
  z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(65535).default(fallback),
  );

const notMainnet = (label: string) => (value: string, ctx: z.RefinementCtx) => {
  if (isMainnetIdentifier(value)) {
    ctx.addIssue({ code: "custom", message: `${label} identifies Solana mainnet; only devnet is allowed` });
  }
};

const httpUrl = z.url({ protocol: /^https?$/ });

/**
 * "devnet" is the only profile that reaches a public cluster. "local-test-validator" runs the
 * services against a loopback solana-test-validator for integration tests and rehearsals: the RPC
 * and facilitator must be loopback, and the chain guard refuses devnet and mainnet genesis.
 */
export const CHAIN_PROFILES = ["devnet", "local-test-validator"] as const;
export type ChainProfile = (typeof CHAIN_PROFILES)[number];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const isLoopbackUrl = (value: string): boolean => {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
};

const envSchema = z.object({
  DEVNET_RPC_URL: httpUrl,
  EXPECTED_DEVNET_GENESIS_HASH: z
    .string()
    .trim()
    .superRefine(notMainnet("EXPECTED_DEVNET_GENESIS_HASH"))
    .refine((v) => v === DEVNET_GENESIS_HASH, `must equal the devnet genesis hash ${DEVNET_GENESIS_HASH}`),
  SOLANA_CAIP2_NETWORK: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .superRefine(notMainnet("SOLANA_CAIP2_NETWORK"))
      .refine((v) => v === DEVNET_CAIP2, `must equal ${DEVNET_CAIP2}`)
      .default(DEVNET_CAIP2),
  ),
  DEMO_TOKEN_MINT: z
    .string()
    .trim()
    .refine((v) => v === DEMO_TOKEN_MINT, `must equal the pinned devnet test mint ${DEMO_TOKEN_MINT}`),
  FACILITATOR_URL: httpUrl,
  VEILO_CHAIN_PROFILE: z.preprocess(emptyToUndefined, z.enum(CHAIN_PROFILES).default("devnet")),
  POOL_PROGRAM_ID: optionalAddress,
  POOL_ID: optionalString,
  DEPLOYMENT_MANIFEST_PATH: z.preprocess(
    emptyToUndefined,
    z.string().default("artifacts/deployment/devnet.json"),
  ),
  OPENROUTER_API_KEY: optionalString,
  PLANNER_MODEL_ID: optionalString,
  INFERENCE_MODEL_ID: optionalString,
  OPERATOR_MAX_REAL_USD_MICRO: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .regex(/^(0|[1-9][0-9]*)$/, "must be a non-negative integer in micro-USD")
      .default("0"),
  ),
  SPONSOR_KEY_PATH: optionalString,
  OWNER_SERVICE_SECRET_PATH: optionalString,
  CONTROL_DATABASE_PATH: z.preprocess(emptyToUndefined, z.string().default("data/control.sqlite")),
  GATEWAY_DATABASE_PATH: z.preprocess(emptyToUndefined, z.string().default("data/gateway.sqlite")),
  VEILO_DATA_DIR: z.preprocess(emptyToUndefined, z.string().default("data")),
  VEILO_SECRETS_DIR: z.preprocess(emptyToUndefined, z.string().default("secrets")),
  VEILO_BIND_HOST: z.preprocess(emptyToUndefined, z.string().default("127.0.0.1")),
  DASHBOARD_PORT: port(DEFAULT_PORTS.dashboard),
  CONTROL_PORT: port(DEFAULT_PORTS.control),
  RUNNER_PORT: port(DEFAULT_PORTS.runner),
  WALLET_PORT: port(DEFAULT_PORTS.wallet),
  GATEWAY_PORT: port(DEFAULT_PORTS.gateway),
  RELAYER_PORT: port(DEFAULT_PORTS.relayer),
  CONTROL_SERVICE_CREDENTIAL_PATH: optionalString,
  RUNNER_WORKER_CREDENTIAL_PATH: optionalString,
  WALLET_SERVICE_CREDENTIAL_PATH: optionalString,
  GATEWAY_ADMIN_CREDENTIAL_PATH: optionalString,
  RELAYER_SERVICE_CREDENTIAL_PATH: optionalString,
});

export interface VeiloConfig {
  network: {
    profile: ChainProfile;
    rpcUrl: string;
    genesisHash: string;
    caip2: string;
    mint: string;
    mintDecimals: number;
    facilitatorUrl: string;
  };
  pool: {
    programId: string | undefined;
    poolId: string | undefined;
    deploymentManifestPath: string;
  };
  inference: {
    plannerModelId: string | undefined;
    inferenceModelId: string | undefined;
    operatorMaxRealUsdMicro: bigint;
    /** False unless both a provider key and a nonzero real-dollar ceiling are configured. */
    realInferenceEnabled: boolean;
  };
  /** Held in memory only for the gateway adapter; excluded from describeConfig output. */
  openRouterApiKey: string | undefined;
  paths: {
    dataDir: string;
    secretsDir: string;
    controlDatabase: string;
    gatewayDatabase: string;
    sponsorKey: string | undefined;
    ownerServiceSecret: string | undefined;
    serviceCredentials: Record<Exclude<ServiceName, "dashboard">, string | undefined>;
  };
  bindHost: string;
  ports: Record<ServiceName, number>;
}

export interface LoadConfigOptions {
  /** Base directory for relative paths; defaults to the current working directory. */
  rootDir?: string;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = {},
): VeiloConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Issue messages reference variable names only, never submitted values.
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    const mainnet = parsed.error.issues.some((i) => i.message.includes("mainnet"));
    const mint = parsed.error.issues.some((i) => i.path[0] === "DEMO_TOKEN_MINT");
    throw new VeiloConfigError(
      mainnet ? "WRONG_NETWORK" : mint ? "WRONG_MINT" : "INVALID_CONFIG",
      `Invalid Veilo configuration: ${details}`,
    );
  }
  const e = parsed.data;
  if (e.VEILO_CHAIN_PROFILE === "devnet" && !e.FACILITATOR_URL.startsWith("https:")) {
    throw new VeiloConfigError("INVALID_CONFIG", "Invalid Veilo configuration: FACILITATOR_URL: must use https");
  }
  if (e.VEILO_CHAIN_PROFILE === "local-test-validator" && (!isLoopbackUrl(e.DEVNET_RPC_URL) || !isLoopbackUrl(e.FACILITATOR_URL))) {
    throw new VeiloConfigError("INVALID_CONFIG", "Invalid Veilo configuration: VEILO_CHAIN_PROFILE=local-test-validator requires loopback DEVNET_RPC_URL and FACILITATOR_URL");
  }
  const rootDir = options.rootDir ?? process.cwd();
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(rootDir, p));
  const absOpt = (p: string | undefined) => (p === undefined ? undefined : abs(p));
  const ceiling = BigInt(e.OPERATOR_MAX_REAL_USD_MICRO);

  return {
    network: {
      profile: e.VEILO_CHAIN_PROFILE,
      rpcUrl: e.DEVNET_RPC_URL,
      genesisHash: e.EXPECTED_DEVNET_GENESIS_HASH,
      caip2: e.SOLANA_CAIP2_NETWORK,
      mint: e.DEMO_TOKEN_MINT,
      mintDecimals: DEMO_TOKEN_DECIMALS,
      facilitatorUrl: e.FACILITATOR_URL,
    },
    pool: {
      programId: e.POOL_PROGRAM_ID,
      poolId: e.POOL_ID,
      deploymentManifestPath: abs(e.DEPLOYMENT_MANIFEST_PATH),
    },
    inference: {
      plannerModelId: e.PLANNER_MODEL_ID,
      inferenceModelId: e.INFERENCE_MODEL_ID,
      operatorMaxRealUsdMicro: ceiling,
      realInferenceEnabled: ceiling > 0n && e.OPENROUTER_API_KEY !== undefined,
    },
    openRouterApiKey: e.OPENROUTER_API_KEY,
    paths: {
      dataDir: abs(e.VEILO_DATA_DIR),
      secretsDir: abs(e.VEILO_SECRETS_DIR),
      controlDatabase: abs(e.CONTROL_DATABASE_PATH),
      gatewayDatabase: abs(e.GATEWAY_DATABASE_PATH),
      sponsorKey: absOpt(e.SPONSOR_KEY_PATH),
      ownerServiceSecret: absOpt(e.OWNER_SERVICE_SECRET_PATH),
      serviceCredentials: {
        control: absOpt(e.CONTROL_SERVICE_CREDENTIAL_PATH),
        runner: absOpt(e.RUNNER_WORKER_CREDENTIAL_PATH),
        wallet: absOpt(e.WALLET_SERVICE_CREDENTIAL_PATH),
        gateway: absOpt(e.GATEWAY_ADMIN_CREDENTIAL_PATH),
        relayer: absOpt(e.RELAYER_SERVICE_CREDENTIAL_PATH),
      },
    },
    bindHost: e.VEILO_BIND_HOST,
    ports: {
      dashboard: e.DASHBOARD_PORT,
      control: e.CONTROL_PORT,
      runner: e.RUNNER_PORT,
      wallet: e.WALLET_PORT,
      gateway: e.GATEWAY_PORT,
      relayer: e.RELAYER_PORT,
    },
  };
}

/**
 * Printable summary. Secret values are reduced to "set"/"unset"; secret file paths are
 * shown but their contents are never read here.
 */
export function describeConfig(config: VeiloConfig): Record<string, unknown> {
  return {
    network: { ...config.network, rpcUrl: redactUrl(config.network.rpcUrl) },
    pool: config.pool,
    inference: {
      plannerModelId: config.inference.plannerModelId ?? null,
      inferenceModelId: config.inference.inferenceModelId ?? null,
      operatorMaxRealUsdMicro: config.inference.operatorMaxRealUsdMicro.toString(),
      realInferenceEnabled: config.inference.realInferenceEnabled,
      openRouterApiKey: config.openRouterApiKey === undefined ? "unset" : "set",
    },
    paths: config.paths,
    bindHost: config.bindHost,
    ports: config.ports,
  };
}

/** RPC URLs may embed provider API keys in the path or query; only the origin is printable. */
export function redactUrl(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname === "/" && parsed.search === "" ? parsed.origin : `${parsed.origin}/…`;
}
