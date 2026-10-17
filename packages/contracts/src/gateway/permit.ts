import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { GATEWAY_SKUS } from "./catalog";
import { canonicalJson, REQUEST_DIGEST_PATTERN } from "./digest";

/**
 * Usage permit v1.
 *
 * Wire form: `vup1.<base64url(payload)>.<base64url(signature)>` where `payload` is the
 * canonical JSON of {@link UsagePermitPayload} and `signature` is Ed25519 over
 * `"veilo:usage-permit:v1\n" || payload`. The control service holds the private key;
 * the gateway holds only the public key. A permit is single-use (its `nonce` is consumed
 * at authorization) and short-lived (`exp - iat` at most {@link MAX_PERMIT_LIFETIME_SECONDS}).
 */
export const USAGE_PERMIT_PREFIX = "vup1";
export const USAGE_PERMIT_DOMAIN = "veilo:usage-permit:v1\n";
export const MAX_PERMIT_LIFETIME_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 30;

const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const decimalUnits = z.string().regex(/^[1-9][0-9]{0,17}$/, "units must be a positive integer decimal string");

export const usagePermitPayloadSchema = z
  .object({
    v: z.literal(1),
    typ: z.literal("usage-permit"),
    /** Gateway identity the permit is addressed to. */
    aud: z.string().min(1).max(128),
    /** Single-use nonce; also the permit ID. */
    nonce: opaqueId,
    accountId: opaqueId,
    sku: z.enum(GATEWAY_SKUS),
    units: decimalUnits,
    requestDigest: z.string().regex(REQUEST_DIGEST_PATTERN),
    operationId: opaqueId,
    /** Opaque authority scope chosen by control; never emitted on chain. */
    scope: z.string().min(1).max(256),
    /** Optional opaque attribution references for usage reporting. */
    agentRef: opaqueId.optional(),
    taskRef: opaqueId.optional(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

export type UsagePermitPayload = z.infer<typeof usagePermitPayloadSchema>;

export class UsagePermitError extends Error {
  readonly reason:
    | "malformed"
    | "bad_signature"
    | "expired"
    | "not_yet_valid"
    | "lifetime_too_long"
    | "wrong_audience";

  constructor(reason: UsagePermitError["reason"], message: string) {
    super(message);
    this.name = "UsagePermitError";
    this.reason = reason;
  }
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function signingInput(payloadBytes: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(USAGE_PERMIT_DOMAIN, "utf8"), payloadBytes]);
}

export function signUsagePermit(payload: UsagePermitPayload, privateKey: KeyObject): string {
  const parsed = usagePermitPayloadSchema.parse(payload);
  if (parsed.exp <= parsed.iat) throw new UsagePermitError("malformed", "exp must be after iat");
  if (parsed.exp - parsed.iat > MAX_PERMIT_LIFETIME_SECONDS) {
    throw new UsagePermitError("lifetime_too_long", `permit lifetime exceeds ${MAX_PERMIT_LIFETIME_SECONDS}s`);
  }
  const payloadBytes = Buffer.from(canonicalJson(parsed), "utf8");
  const signature = cryptoSign(null, signingInput(payloadBytes), privateKey);
  return `${USAGE_PERMIT_PREFIX}.${b64url(payloadBytes)}.${b64url(signature)}`;
}

export interface VerifyUsagePermitOptions {
  publicKey: KeyObject;
  audience: string;
  nowSeconds?: number;
}

/** Verifies signature, schema, audience and validity window. Does not track nonce use. */
export function verifyUsagePermit(token: string, options: VerifyUsagePermitOptions): UsagePermitPayload {
  if (typeof token !== "string" || token.length > 4096) {
    throw new UsagePermitError("malformed", "permit must be a string");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== USAGE_PERMIT_PREFIX) {
    throw new UsagePermitError("malformed", "permit format not recognized");
  }
  const payloadBytes = Buffer.from(parts[1] ?? "", "base64url");
  const signature = Buffer.from(parts[2] ?? "", "base64url");
  if (signature.length !== 64) throw new UsagePermitError("malformed", "permit signature has wrong length");
  if (!cryptoVerify(null, signingInput(payloadBytes), options.publicKey, signature)) {
    throw new UsagePermitError("bad_signature", "permit signature is invalid");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new UsagePermitError("malformed", "permit payload is not JSON");
  }
  const parsed = usagePermitPayloadSchema.safeParse(raw);
  if (!parsed.success) throw new UsagePermitError("malformed", "permit payload failed schema validation");
  const payload = parsed.data;
  // The signed bytes must be the canonical encoding, so a payload has exactly one valid form.
  if (canonicalJson(payload) !== payloadBytes.toString("utf8")) {
    throw new UsagePermitError("malformed", "permit payload is not canonical");
  }
  if (payload.aud !== options.audience) throw new UsagePermitError("wrong_audience", "permit audience mismatch");
  if (payload.exp <= payload.iat || payload.exp - payload.iat > MAX_PERMIT_LIFETIME_SECONDS) {
    throw new UsagePermitError("lifetime_too_long", "permit validity window is invalid");
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.iat > now + CLOCK_SKEW_SECONDS) throw new UsagePermitError("not_yet_valid", "permit issued in the future");
  if (now >= payload.exp) throw new UsagePermitError("expired", "permit expired");
  return payload;
}

export interface UsagePermitKeyPairPem {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateUsagePermitKeyPair(): UsagePermitKeyPairPem {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

export function loadUsagePermitPrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("usage permit signing key must be Ed25519");
  return key;
}

export function loadUsagePermitPublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("usage permit public key must be Ed25519");
  return key;
}
