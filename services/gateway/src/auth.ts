import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { GatewayDb } from "./db/database";
import { GatewayError } from "./errors";

export interface AccountRow {
  id: string;
  workspace_id: string;
  subject: string;
  status: "active" | "stopped";
  issued: bigint;
  reserved: bigint;
  consumed: bigint;
  version: bigint;
  created_at: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(header.trim());
  return match?.[1];
}

/** Resolves the account for a bearer token. Unguessable IDs alone never authenticate. */
export function authenticateAccount(db: GatewayDb, authorization: string | undefined): AccountRow {
  const token = bearerToken(authorization);
  if (!token) throw new GatewayError(401, "UNAUTHENTICATED", "Bearer account credential required");
  const row = db
    .prepare("SELECT id, workspace_id, subject, status, issued, reserved, consumed, version, created_at FROM accounts WHERE token_hash = ?")
    .get(hashToken(token)) as AccountRow | undefined;
  if (!row) throw new GatewayError(401, "UNAUTHENTICATED", "Unknown account credential");
  return row;
}

export interface CreatedAccount {
  accountId: string;
  token: string;
}

/**
 * Creates the single persistent gateway account for a workspace. The returned token is the
 * only copy; the database keeps its SHA-256 hash.
 */
export function createAccount(db: GatewayDb, workspaceId: string, subject: string, now: Date = new Date()): CreatedAccount {
  const token = `vga_${randomBytes(32).toString("base64url")}`;
  const accountId = `acct_${randomUUID()}`;
  try {
    db.prepare(
      "INSERT INTO accounts (id, workspace_id, subject, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(accountId, workspaceId, subject, hashToken(token), now.toISOString());
  } catch (error) {
    if (String((error as Error).message).includes("UNIQUE")) {
      throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Workspace already has a gateway account");
    }
    throw error;
  }
  return { accountId, token };
}

/** Constant-time check of a bearer token against a stored hash (planning/admin credentials). */
export function tokenMatchesHash(authorization: string | undefined, expectedHash: string | undefined): boolean {
  const token = bearerToken(authorization);
  if (!token || !expectedHash) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
