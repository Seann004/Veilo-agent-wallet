import { createHash, timingSafeEqual } from "node:crypto";
import { getBase58Encoder, getPublicKeyFromAddress, isAddress, verifySignature, type Address, type SignatureBytes } from "@solana/kit";
import type { User } from "@supabase/supabase-js";
import { CONTROLLER_HEADERS, CONTROLLER_REQUEST_MAX_SKEW_MS, controllerSigningMessage } from "@veilo/contracts/marketplace";
import type { Request } from "express";
import type { Db } from "./db";
import { MarketError } from "./errors";

export interface UserActor {
  userId: string;
  address: string;
  accessToken: string;
}

export interface ControllerActor {
  workspaceId: string;
  keyId: string;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * The wallet address of a Web3 sign-in, read only from the Auth server's identity record.
 * Editable user metadata is never trusted for identity.
 */
export function walletAddressOf(user: User): string | null {
  for (const identity of user.identities ?? []) {
    if (identity.provider !== "web3") continue;
    const data = (identity.identity_data ?? {}) as Record<string, unknown>;
    const candidates = [data.address, data.wallet_address, data.sub, identity.id].filter((v): v is string => typeof v === "string");
    for (const raw of candidates) {
      const solana = /^web3:solana:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(raw);
      const value = solana?.[1] ?? raw;
      if (isAddress(value) && (solana || data.chain === "solana" || String(data.sub ?? "").startsWith("web3:solana:"))) return value;
    }
  }
  return null;
}

export function bearer(req: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,4096})$/.exec(req.header("authorization")?.trim() ?? "");
  return match?.[1] ?? null;
}

export async function authenticateUser(db: Db, req: Request): Promise<UserActor> {
  const token = bearer(req);
  if (!token) throw new MarketError("UNAUTHENTICATED", "sign in with your wallet first");
  const user = await db.getUser(token);
  if (!user) throw new MarketError("UNAUTHENTICATED", "session is invalid or expired");
  const address = walletAddressOf(user);
  if (!address) throw new MarketError("FORBIDDEN", "account has no verified Solana wallet identity");
  return { userId: user.id, address, accessToken: token };
}

/** Constant-time check of a bearer credential against its configured SHA-256. */
export function bearerMatches(req: Request, expectedSha256: string | null): boolean {
  const token = bearer(req);
  if (!token || !expectedSha256) return false;
  const a = Buffer.from(sha256Hex(token), "hex");
  const b = Buffer.from(expectedSha256, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function verifyEd25519(address: string, signatureBase58: string, message: string): Promise<boolean> {
  if (!isAddress(address)) return false;
  let sig: Uint8Array;
  try {
    sig = new Uint8Array(getBase58Encoder().encode(signatureBase58));
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  const key = await getPublicKeyFromAddress(address as Address);
  return verifySignature(key, sig as SignatureBytes, new TextEncoder().encode(message));
}

interface ControllerLookup {
  workspaceId: string;
  controllerKey: string;
}

/**
 * Authenticates a signed controller request: registered key, fresh timestamp, single-use
 * nonce and a signature over method, path, exact body bytes, timestamp and nonce.
 */
export async function authenticateController(
  req: Request & { rawBody?: Buffer },
  lookup: (keyId: string) => Promise<ControllerLookup | null>,
  consumeNonce: (keyId: string, nonce: string) => Promise<boolean>,
  nowMs: number = Date.now(),
): Promise<ControllerActor> {
  const keyId = req.header(CONTROLLER_HEADERS.keyId) ?? "";
  const timestamp = req.header(CONTROLLER_HEADERS.timestamp) ?? "";
  const nonce = req.header(CONTROLLER_HEADERS.nonce) ?? "";
  const signature = req.header(CONTROLLER_HEADERS.signature) ?? "";
  if (!/^ctl_[A-Za-z0-9_-]{8,64}$/.test(keyId) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !signature) {
    throw new MarketError("UNAUTHENTICATED", "missing controller signature headers");
  }
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > CONTROLLER_REQUEST_MAX_SKEW_MS) {
    throw new MarketError("UNAUTHENTICATED", "controller timestamp outside the allowed window");
  }
  const registered = await lookup(keyId);
  if (!registered) throw new MarketError("UNAUTHENTICATED", "unknown controller key");
  const body = req.rawBody && req.rawBody.length > 0 ? req.rawBody : new Uint8Array();
  const message = controllerSigningMessage({ method: req.method, path: req.originalUrl, bodyDigest: sha256Hex(body), timestamp, nonce, keyId });
  if (!(await verifyEd25519(registered.controllerKey, signature, message))) {
    throw new MarketError("UNAUTHENTICATED", "controller signature invalid");
  }
  // The nonce is consumed only after the signature verifies, so forged requests cannot burn nonces.
  if (!(await consumeNonce(keyId, nonce))) throw new MarketError("UNAUTHENTICATED", "controller nonce already used");
  return { workspaceId: registered.workspaceId, keyId };
}

/** Small fixed-window limiter keyed by principal and route; enough to bound abuse on one host. */
export class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  check(key: string, nowMs: number = Date.now()): void {
    const w = this.#windows.get(key);
    if (!w || nowMs - w.start >= this.windowMs) {
      this.#windows.set(key, { start: nowMs, count: 1 });
      if (this.#windows.size > 50_000) this.#windows.clear();
      return;
    }
    w.count += 1;
    if (w.count > this.limit) throw new MarketError("RATE_LIMITED", "too many requests; retry shortly");
  }
}
