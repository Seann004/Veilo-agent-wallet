import { MARKETPLACE_LIMITS } from "@veilo/contracts/marketplace";

export interface MarketplaceConfig {
  port: number;
  bindHost: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
  supabasePublishableKey: string;
  rpcUrl: string;
  /** CAIP-2 network and genesis hash every quote and receipt must carry. */
  network: string;
  genesisHash: string;
  mint: string;
  decimals: number;
  /** SHA-256 hex of the seller-host bearer credential; the raw token never lives here. */
  sellerHostTokenHash: string | null;
  operatorTokenHash: string | null;
  managedSellerOrigin: string | null;
  managedSellerIdentity: string;
  /** Exact loopback or private origins admitted for local test sellers only. */
  devSellerOrigins: readonly string[];
  allowedBrowserOrigins: readonly string[];
  maxNetworkFeeLamports: bigint;
  quoteTtlSeconds: number;
  termsVersion: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MarketplaceConfig {
  const genesisHash = required(env, "EXPECTED_DEVNET_GENESIS_HASH");
  return {
    port: Number(env.MARKETPLACE_PORT ?? 4106),
    bindHost: env.VEILO_BIND_HOST?.trim() || "127.0.0.1",
    supabaseUrl: required(env, "SUPABASE_URL"),
    supabaseSecretKey: required(env, "SUPABASE_SECRET_KEY"),
    supabasePublishableKey: required(env, "SUPABASE_PUBLISHABLE_KEY"),
    rpcUrl: required(env, "DEVNET_RPC_URL"),
    network: `solana:${genesisHash.slice(0, 32)}`,
    genesisHash,
    mint: required(env, "DEMO_TOKEN_MINT"),
    decimals: Number(env.DEMO_TOKEN_DECIMALS ?? 6),
    sellerHostTokenHash: env.MARKETPLACE_SELLER_HOST_TOKEN_SHA256?.trim() || null,
    operatorTokenHash: env.MARKETPLACE_OPERATOR_TOKEN_SHA256?.trim() || null,
    managedSellerOrigin: env.MARKETPLACE_MANAGED_SELLER_ORIGIN?.trim().replace(/\/$/, "") || null,
    managedSellerIdentity: env.MARKETPLACE_MANAGED_SELLER_IDENTITY?.trim() || "veilo-seller-host-devnet",
    devSellerOrigins: list(env.MARKETPLACE_DEV_SELLER_ORIGINS),
    allowedBrowserOrigins: list(env.MARKETPLACE_BROWSER_ORIGINS ?? "http://localhost:3000"),
    maxNetworkFeeLamports: BigInt(env.MARKETPLACE_MAX_NETWORK_FEE_LAMPORTS ?? "10000000"),
    quoteTtlSeconds: Number(env.MARKETPLACE_QUOTE_TTL_SECONDS ?? MARKETPLACE_LIMITS.quoteTtlSeconds),
    termsVersion: env.MARKETPLACE_TERMS_VERSION?.trim() || "2026-10-17",
  };
}
