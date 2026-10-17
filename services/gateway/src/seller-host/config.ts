import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isAddress } from "@solana/kit";
import { z } from "zod";
import { isLoopbackUrl, VeiloConfigError, type VeiloConfig } from "@veilo/contracts";
import type { GatewayConfig } from "@veilo/contracts/gateway";
import { MARKETPLACE_LIMITS } from "@veilo/contracts/marketplace";
import type { GatewayRole } from "../context";

const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const intIn = (min: number, max: number, fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(fallback));

const envSchema = z.object({
  GATEWAY_ROLE: z.preprocess(emptyToUndefined, z.enum(["operator", "seller-host"]).default("operator")),
  SELLER_HOST_IDENTITY: z.preprocess(emptyToUndefined, z.string().regex(/^[a-z0-9-]{3,64}$/).default("veilo-seller-host-devnet")),
  SELLER_HOST_PUBLIC_ORIGIN: z.preprocess(emptyToUndefined, z.url({ protocol: /^https?$/ }).optional()),
  SELLER_HOST_PORT: intIn(1, 65_535, 4106),
  SELLER_HOST_DATABASE_PATH: z.preprocess(emptyToUndefined, z.string().default("data/seller-host.sqlite")),
  SELLER_HOST_RECIPIENTS: optionalString,
  SELLER_HOST_ACCOUNTS_PER_IP_HOUR: intIn(1, 1_000, 5),
  MARKETPLACE_URL: z.preprocess(emptyToUndefined, z.url({ protocol: /^https?$/ }).optional()),
  MARKETPLACE_SELLER_HOST_TOKEN: optionalString,
  MARKETPLACE_SELLER_HOST_TOKEN_PATH: optionalString,
});

export interface SellerHostConfig {
  identity: string;
  publicOrigin: string;
  port: number;
  databasePath: string;
  allowedRecipients: string[];
  accountsPerIpHour: number;
  marketplaceUrl: string;
  /** Held in memory only; never printed. */
  marketplaceToken: string;
}

export function gatewayRole(env: Record<string, string | undefined> = process.env): GatewayRole {
  const parsed = envSchema.shape.GATEWAY_ROLE.safeParse(env.GATEWAY_ROLE);
  if (!parsed.success) throw new VeiloConfigError("INVALID_CONFIG", "GATEWAY_ROLE must be operator or seller-host");
  return parsed.data;
}

/**
 * Seller-host settings. The host keeps its own identity, origin, port and database so it can
 * never share a ledger or an x402 resource namespace with the operator gateway.
 */
export function loadSellerHostConfig(
  base: VeiloConfig,
  operator: GatewayConfig,
  env: Record<string, string | undefined> = process.env,
  options: { rootDir?: string } = {},
): SellerHostConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new VeiloConfigError("INVALID_CONFIG", `Invalid seller-host configuration: ${details}`);
  }
  const e = parsed.data;
  const rootDir = options.rootDir ?? process.cwd();
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(rootDir, p));
  const fail = (message: string) => {
    throw new VeiloConfigError("INVALID_CONFIG", `Invalid seller-host configuration: ${message}`);
  };

  if (!e.MARKETPLACE_URL) fail("MARKETPLACE_URL is required");
  const marketplaceUrl = (e.MARKETPLACE_URL as string).replace(/\/$/, "");
  if (!marketplaceUrl.startsWith("https:") && !isLoopbackUrl(marketplaceUrl)) fail("MARKETPLACE_URL must use https unless it is a loopback URL");

  let token = e.MARKETPLACE_SELLER_HOST_TOKEN;
  if (e.MARKETPLACE_SELLER_HOST_TOKEN_PATH) {
    const path = abs(e.MARKETPLACE_SELLER_HOST_TOKEN_PATH);
    if (!existsSync(path)) fail("MARKETPLACE_SELLER_HOST_TOKEN_PATH does not exist");
    const fromFile = readFileSync(path, "utf8").trim();
    if (token !== undefined && token !== fromFile) fail("MARKETPLACE_SELLER_HOST_TOKEN and its _PATH file disagree");
    token = fromFile;
  }
  if (!token || token.length < 16) fail("a marketplace seller-host token of at least 16 characters is required");

  const recipients = (e.SELLER_HOST_RECIPIENTS ?? "").split(",").map((r) => r.trim()).filter((r) => r !== "");
  for (const r of recipients) if (!isAddress(r)) fail("SELLER_HOST_RECIPIENTS must be base58 Solana addresses");

  const publicOrigin = (e.SELLER_HOST_PUBLIC_ORIGIN ?? `http://${base.bindHost}:${e.SELLER_HOST_PORT}`).replace(/\/$/, "");
  const databasePath = abs(e.SELLER_HOST_DATABASE_PATH);
  if (e.SELLER_HOST_IDENTITY === operator.identity) fail("SELLER_HOST_IDENTITY must differ from GATEWAY_IDENTITY");
  if (publicOrigin === operator.publicOrigin) fail("SELLER_HOST_PUBLIC_ORIGIN must differ from GATEWAY_PUBLIC_ORIGIN");
  if (databasePath === base.paths.gatewayDatabase) fail("SELLER_HOST_DATABASE_PATH must differ from GATEWAY_DATABASE_PATH");
  if (e.SELLER_HOST_PORT === base.ports.gateway) fail("SELLER_HOST_PORT must differ from GATEWAY_PORT");

  return {
    identity: e.SELLER_HOST_IDENTITY,
    publicOrigin,
    port: e.SELLER_HOST_PORT,
    databasePath,
    allowedRecipients: recipients,
    accountsPerIpHour: e.SELLER_HOST_ACCOUNTS_PER_IP_HOUR,
    marketplaceUrl,
    marketplaceToken: token as string,
  };
}

/**
 * Claim retry schedule within one fulfilment pass while the marketplace has not queued a paid
 * job yet. Kept short because the pass runs inside a buyer's request; later passes continue it.
 */
export const CLAIM_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
export const HEARTBEAT_MS = MARKETPLACE_LIMITS.heartbeatSeconds * 1000;
