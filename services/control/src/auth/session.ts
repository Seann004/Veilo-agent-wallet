import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getBase58Encoder, getPublicKeyFromAddress, verifySignature, type Address, type SignatureBytes } from "@solana/kit";
import { DEVNET_CAIP2 } from "@veilo/contracts";
import { immediate } from "@veilo/db";
import { num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { writeAudit } from "../ledger/events";
import { getWorkspace } from "../ledger/workspace";

export interface SessionSettings {
  /** Host (and port) the dashboard is served from; bound into every challenge. */
  domain: string;
  /** Exact browser origin allowed to call mutating endpoints. */
  origin: string;
  /** CAIP-2 chain id bound into the challenge (devnet only). */
  chainId: string;
  challengeTtlMs: number;
  sessionTtlMs: number;
  /** Force the Secure cookie attribute even when the request arrived over plain HTTP. */
  secureCookies: boolean;
  /** Wallets allowed to sign in as guests (read everything, run agents, nothing else). Never the owner. */
  guestPubkeys?: readonly string[];
  /** Serves anonymous read-only (redacted) views when no session is presented. Off unless set. */
  publicView?: boolean;
  /** Agent runs one guest wallet may start per rolling hour. */
  guestRunsPerHour?: number;
}

export type SessionRole = "owner" | "guest";

export const DEFAULT_GUEST_RUNS_PER_HOUR = 20;

/** Role is derived from the current workspace owner and guest list on every check, never stored. */
export function sessionRole(ownerPubkey: string | undefined, guestPubkeys: readonly string[] | undefined, address: string): SessionRole | null {
  if (ownerPubkey !== undefined && address === ownerPubkey) return "owner";
  if ((guestPubkeys ?? []).includes(address)) return "guest";
  return null;
}

const auditActor = (role: SessionRole | null): { actorType: "owner" | "system"; guest: boolean } =>
  role === "guest" ? { actorType: "system", guest: true } : { actorType: "owner", guest: false };

export const SESSION_COOKIE = "veilo_session";
export const CSRF_HEADER = "x-csrf-token";

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/**
 * Sign In With Solana names the cluster ("devnet"), not the CAIP-2 genesis form; wallets such as
 * Phantom refuse to display a message whose Chain ID they cannot parse. Only devnet is accepted.
 */
function signInChainId(caip2: string): string {
  if (caip2 !== DEVNET_CAIP2) throw new ControlError("WRONG_NETWORK", "sign-in is only issued for Solana devnet");
  return "devnet";
}

export function buildChallengeMessage(p: {
  domain: string;
  address: string;
  origin: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  role?: SessionRole;
}): string {
  return [
    `${p.domain} wants you to sign in with your Solana account:`,
    p.address,
    "",
    p.role === "guest"
      ? "Sign in to the Veilo workspace as a guest. This signature does not authorize any transaction."
      : "Sign in to the Veilo owner workspace. This signature does not authorize any transaction.",
    "",
    `URI: ${p.origin}`,
    "Version: 1",
    `Chain ID: ${signInChainId(p.chainId)}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
    `Expiration Time: ${p.expiresAt}`,
  ].join("\n");
}

export function createChallenge(
  ledger: Ledger,
  settings: SessionSettings,
  address: string,
): { nonce: string; message: string; expiresAt: string; role: SessionRole } {
  return immediate(ledger.db, () => {
    const ws = getWorkspace(ledger);
    if (!ws) throw new ControlError("NOT_FOUND", "workspace is not initialized");
    const role = sessionRole(ws.owner_pubkey, settings.guestPubkeys, address);
    if (!role) throw new ControlError("POLICY_DENIED", "address is not the workspace owner or an approved guest");
    const now = ledger.now();
    // Sign In With Solana nonces are alphanumeric; base64url's "-" and "_" are rejected by wallets.
    const nonce = randomBytes(24).toString("hex");
    const expiresAtMs = now + settings.challengeTtlMs;
    const message = buildChallengeMessage({
      domain: settings.domain,
      address,
      origin: settings.origin,
      chainId: settings.chainId,
      nonce,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      role,
    });
    ledger.db
      .prepare(
        `INSERT INTO owner_session_challenge (nonce, address, domain, message, issued_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(nonce, address, settings.domain, message, now, expiresAtMs);
    return { nonce, message, expiresAt: new Date(expiresAtMs).toISOString(), role };
  });
}

export interface IssuedSession {
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
  address: string;
  role: SessionRole;
}

interface ChallengeRow {
  nonce: string;
  address: string;
  domain: string;
  message: string;
  expires_at_ms: bigint;
}

/**
 * Verifies an Ed25519 signature over the exact issued challenge. The nonce is consumed before
 * the signature is checked, so every challenge is single-use whether verification succeeds or not.
 */
export async function verifyChallenge(
  ledger: Ledger,
  settings: SessionSettings,
  body: { address: string; nonce: string; signature: string; message?: string | undefined },
): Promise<IssuedSession> {
  const challenge = immediate(ledger.db, () => {
    const row = ledger.db.prepare(`SELECT * FROM owner_session_challenge WHERE nonce = ?`).get(body.nonce) as ChallengeRow | undefined;
    if (!row) throw new ControlError("UNAUTHENTICATED", "unknown challenge");
    const r = ledger.db
      .prepare(`UPDATE owner_session_challenge SET consumed_at_ms = ? WHERE nonce = ? AND consumed_at_ms IS NULL`)
      .run(ledger.now(), body.nonce);
    if (r.changes !== 1) throw new ControlError("UNAUTHENTICATED", "challenge was already used");
    return row;
  });
  const fail = (reason: string): never => {
    immediate(ledger.db, () => {
      const ws = getWorkspace(ledger);
      const actor = auditActor(sessionRole(ws?.owner_pubkey, settings.guestPubkeys, body.address));
      writeAudit(ledger, {
        workspaceId: ws?.id ?? null,
        scope: "session",
        actorType: actor.actorType,
        actorId: body.address,
        action: "session.verify",
        policyResult: "denied",
        reasonCode: "UNAUTHENTICATED",
        details: { reason, ...(actor.guest ? { actor: "guest" } : {}) },
      });
    });
    throw new ControlError("UNAUTHENTICATED", reason);
  };

  if (ledger.now() >= num(challenge.expires_at_ms)) fail("challenge expired");
  if (challenge.address !== body.address) fail("challenge was issued to a different address");
  if (challenge.domain !== settings.domain) fail("challenge domain does not match this service");
  if (body.message !== undefined && body.message !== challenge.message) {
    fail("signed message does not match the issued challenge");
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = new Uint8Array(getBase58Encoder().encode(body.signature));
  } catch {
    return fail("signature is not valid base58");
  }
  if (signatureBytes.length !== 64) fail("signature must be 64 bytes");
  let valid: boolean;
  try {
    const key = await getPublicKeyFromAddress(body.address as Address);
    valid = await verifySignature(key, signatureBytes as SignatureBytes, new TextEncoder().encode(challenge.message));
  } catch {
    valid = false;
  }
  if (!valid) fail("signature verification failed");

  return immediate(ledger.db, () => {
    const ws = getWorkspace(ledger);
    const role = ws ? sessionRole(ws.owner_pubkey, settings.guestPubkeys, body.address) : null;
    if (!ws || !role) throw new ControlError("POLICY_DENIED", "address is not the workspace owner or an approved guest");
    const actor = auditActor(role);
    const now = ledger.now();
    const sessionToken = `vos_${randomBytes(32).toString("base64url")}`;
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAtMs = now + settings.sessionTtlMs;
    const id = ledger.newId();
    ledger.db
      .prepare(
        `INSERT INTO owner_session (id, token_hash, csrf_hash, workspace_id, owner_pubkey, challenge_nonce, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sha256Hex(sessionToken), sha256Hex(csrfToken), ws.id, body.address, body.nonce, now, expiresAtMs);
    writeAudit(ledger, {
      workspaceId: ws.id,
      scope: "session",
      actorType: actor.actorType,
      actorId: body.address,
      action: "session.verify",
      policyResult: "allowed",
      details: { sessionId: id, ...(actor.guest ? { actor: "guest" } : {}) },
    });
    return { sessionToken, csrfToken, expiresAt: new Date(expiresAtMs).toISOString(), address: body.address, role };
  });
}

export interface AuthenticatedSession {
  id: string;
  workspaceId: string;
  /** The signed-in wallet: the workspace owner, or an approved guest. */
  pubkey: string;
  role: SessionRole;
  csrfHash: string;
  expiresAtMs: number;
}

/**
 * Owner and guest sessions share one table; the role is recomputed on every check, so a session
 * stops working once its wallet is neither the current owner nor in the configured guest list.
 */
export function authenticateSession(ledger: Ledger, token: string, guestPubkeys: readonly string[] = []): AuthenticatedSession | null {
  if (!token.startsWith("vos_")) return null;
  const row = ledger.db
    .prepare(
      `SELECT s.id, s.workspace_id, s.owner_pubkey, s.csrf_hash, s.expires_at_ms, s.revoked_at_ms, w.owner_pubkey AS current_owner
       FROM owner_session s JOIN workspace w ON w.id = s.workspace_id WHERE s.token_hash = ?`,
    )
    .get(sha256Hex(token)) as
    | { id: string; workspace_id: string; owner_pubkey: string; csrf_hash: string; expires_at_ms: bigint; revoked_at_ms: bigint | null; current_owner: string }
    | undefined;
  if (!row || row.revoked_at_ms !== null || num(row.expires_at_ms) <= ledger.now()) return null;
  const role = sessionRole(row.current_owner, guestPubkeys, row.owner_pubkey);
  if (!role) return null;
  return { id: row.id, workspaceId: row.workspace_id, pubkey: row.owner_pubkey, role, csrfHash: row.csrf_hash, expiresAtMs: num(row.expires_at_ms) };
}

export function revokeSession(ledger: Ledger, sessionId: string): void {
  ledger.db.prepare(`UPDATE owner_session SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL`).run(ledger.now(), sessionId);
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}
