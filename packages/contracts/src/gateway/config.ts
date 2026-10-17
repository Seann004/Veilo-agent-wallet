import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isAddress } from "@solana/kit";
import { z } from "zod";
import type { VeiloConfig } from "../config";
import { VeiloConfigError } from "../errors";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalAddress = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .refine((v) => isAddress(v), "must be a base58 Solana address")
    .optional(),
);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const intIn = (min: number, max: number, fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(fallback));

const gatewayEnvSchema = z.object({
  GATEWAY_IDENTITY: z.preprocess(
    emptyToUndefined,
    z.string().regex(/^[a-z0-9-]{3,64}$/).default("veilo-gateway-devnet"),
  ),
  GATEWAY_PUBLIC_ORIGIN: z.preprocess(emptyToUndefined, z.url({ protocol: /^https?$/ }).optional()),
  GATEWAY_MERCHANT_ADDRESS: optionalAddress,
  GATEWAY_MERCHANT_ATA: optionalAddress,
  GATEWAY_FACILITATOR_FEE_PAYER: optionalAddress,
  GATEWAY_QUOTE_TTL_SECONDS: intIn(60, 3_600, 600),
  GATEWAY_PROVIDER_TIMEOUT_MS: intIn(1_000, 120_000, 60_000),
  GATEWAY_PRICING_MAX_AGE_SECONDS: intIn(60, 86_400, 21_600),
  GATEWAY_SETTLEMENT_WAIT_MS: intIn(0, 120_000, 40_000),
  USAGE_PERMIT_PUBLIC_KEY_PATH: optionalString,
  GATEWAY_PLANNING_CREDENTIAL_PATH: optionalString,
});

const manifestGatewaySchema = z
  .object({
    gateway: z
      .object({
        merchantAddress: z.string().refine((v) => isAddress(v)).optional(),
        merchantAta: z.string().refine((v) => isAddress(v)).optional(),
        facilitatorFeePayer: z.string().refine((v) => isAddress(v)).optional(),
      })
      .optional(),
  })
  .loose();

export interface GatewayConfig {
  identity: string;
  publicOrigin: string;
  /** Merchant wallet that owns the recipient ATA; x402 acceptance is disabled when unset. */
  merchantAddress: string | undefined;
  /** Optional pinned recipient ATA; must equal the derived ATA when set. */
  merchantAta: string | undefined;
  /** The only facilitator fee payer the gateway will name in payment requirements. */
  facilitatorFeePayer: string | undefined;
  quoteTtlSeconds: number;
  providerTimeoutMs: number;
  pricingMaxAgeSeconds: number;
  settlementWaitMs: number;
  usagePermitPublicKeyPath: string | undefined;
  planningCredentialPath: string | undefined;
  adminCredentialPath: string | undefined;
  /** Where each recipient value came from, for health output. */
  sources: Record<"merchantAddress" | "merchantAta" | "facilitatorFeePayer", "env" | "manifest" | "unset">;
}

function pick(
  name: string,
  envValue: string | undefined,
  manifestValue: string | undefined,
): { value: string | undefined; source: "env" | "manifest" | "unset" } {
  if (envValue !== undefined && manifestValue !== undefined && envValue !== manifestValue) {
    throw new VeiloConfigError("INVALID_CONFIG", `${name} differs between environment and deployment manifest`);
  }
  if (manifestValue !== undefined) return { value: manifestValue, source: "manifest" };
  if (envValue !== undefined) return { value: envValue, source: "env" };
  return { value: undefined, source: "unset" };
}

/**
 * Gateway-only settings. Recipient bindings come from the deployment manifest when it
 * has a `gateway` section, otherwise from the environment; a disagreement fails closed.
 */
export function loadGatewayConfig(
  base: VeiloConfig,
  env: Record<string, string | undefined> = process.env,
  options: { rootDir?: string } = {},
): GatewayConfig {
  const parsed = gatewayEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new VeiloConfigError("INVALID_CONFIG", `Invalid gateway configuration: ${details}`);
  }
  const e = parsed.data;
  const rootDir = options.rootDir ?? process.cwd();
  const abs = (p: string | undefined) => (p === undefined ? undefined : isAbsolute(p) ? p : resolve(rootDir, p));

  let manifest: z.infer<typeof manifestGatewaySchema>["gateway"];
  const manifestPath = base.pool.deploymentManifestPath;
  if (existsSync(manifestPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      throw new VeiloConfigError("INVALID_CONFIG", "Deployment manifest is not valid JSON");
    }
    const m = manifestGatewaySchema.safeParse(raw);
    if (!m.success) throw new VeiloConfigError("INVALID_CONFIG", "Deployment manifest gateway section is invalid");
    manifest = m.data.gateway;
  }

  const merchant = pick("GATEWAY_MERCHANT_ADDRESS", e.GATEWAY_MERCHANT_ADDRESS, manifest?.merchantAddress);
  const ata = pick("GATEWAY_MERCHANT_ATA", e.GATEWAY_MERCHANT_ATA, manifest?.merchantAta);
  const feePayer = pick(
    "GATEWAY_FACILITATOR_FEE_PAYER",
    e.GATEWAY_FACILITATOR_FEE_PAYER,
    manifest?.facilitatorFeePayer,
  );

  return {
    identity: e.GATEWAY_IDENTITY,
    publicOrigin: (e.GATEWAY_PUBLIC_ORIGIN ?? `http://${base.bindHost}:${base.ports.gateway}`).replace(/\/$/, ""),
    merchantAddress: merchant.value,
    merchantAta: ata.value,
    facilitatorFeePayer: feePayer.value,
    quoteTtlSeconds: e.GATEWAY_QUOTE_TTL_SECONDS,
    providerTimeoutMs: e.GATEWAY_PROVIDER_TIMEOUT_MS,
    pricingMaxAgeSeconds: e.GATEWAY_PRICING_MAX_AGE_SECONDS,
    settlementWaitMs: e.GATEWAY_SETTLEMENT_WAIT_MS,
    usagePermitPublicKeyPath: abs(e.USAGE_PERMIT_PUBLIC_KEY_PATH),
    planningCredentialPath: abs(e.GATEWAY_PLANNING_CREDENTIAL_PATH),
    adminCredentialPath: base.paths.serviceCredentials.gateway,
    sources: { merchantAddress: merchant.source, merchantAta: ata.source, facilitatorFeePayer: feePayer.source },
  };
}
