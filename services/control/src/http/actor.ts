import type { NextFunction, Request, Response } from "express";
import type { Ledger } from "../context";
import { ControlError } from "../errors";
import { getWorkspace } from "../ledger/workspace";
import { authenticateWorker, type ServiceCredentials, type ServicePrincipal } from "../auth/credentials";
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  authenticateSession,
  safeEqualHex,
  sha256Hex,
  type SessionSettings,
} from "../auth/session";

export type Actor =
  | { kind: "owner"; workspaceId: string; ownerPubkey: string; sessionId: string; csrfHash: string }
  | { kind: "guest"; workspaceId: string; guestPubkey: string; sessionId: string; csrfHash: string }
  /** Anonymous read-only caller; exists only when public view is enabled. */
  | { kind: "viewer"; workspaceId: string }
  | { kind: "worker"; workspaceId: string; agentId: string; credentialId: string }
  | { kind: "service"; service: ServicePrincipal };

export type ActorKind = Actor["kind"];

export interface AuthDeps {
  ledger: Ledger;
  session: SessionSettings;
  services: ServiceCredentials;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

/** Readers of workspace state: every browser role. */
export const READERS: readonly ActorKind[] = ["owner", "guest", "viewer"];

/**
 * Resolves the caller from exactly one credential: a bearer token (worker or service) or the
 * session cookie (owner or guest). Without either, and only with public view enabled, the caller
 * is an anonymous viewer. An invalid bearer token is never downgraded to a viewer. Request bodies
 * never contribute to identity.
 */
export function resolveActor(deps: AuthDeps, req: Request): Actor | null {
  const auth = req.headers.authorization;
  if (auth !== undefined) {
    const match = /^Bearer ([^\s]+)$/.exec(auth);
    if (!match?.[1]) return null;
    const token = match[1];
    const worker = authenticateWorker(deps.ledger, token);
    if (worker) return { kind: "worker", ...worker };
    const service = deps.services.authenticate(token);
    if (service) return { kind: "service", service };
    return null;
  }
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) {
    const s = authenticateSession(deps.ledger, cookie, deps.session.guestPubkeys);
    if (s?.role === "owner") return { kind: "owner", workspaceId: s.workspaceId, ownerPubkey: s.pubkey, sessionId: s.id, csrfHash: s.csrfHash };
    if (s?.role === "guest") return { kind: "guest", workspaceId: s.workspaceId, guestPubkey: s.pubkey, sessionId: s.id, csrfHash: s.csrfHash };
  }
  if (deps.session.publicView === true) {
    const ws = getWorkspace(deps.ledger);
    if (ws) return { kind: "viewer", workspaceId: ws.id };
  }
  return null;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Rejects cross-origin browser requests; non-browser callers send no Origin header. */
export function assertOrigin(deps: AuthDeps, req: Request): void {
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== deps.session.origin) {
    throw new ControlError("FORBIDDEN", "request origin is not allowed");
  }
}

/**
 * `csrf: false` is only for ending the caller's own session: the Origin check still applies, and
 * a forged request can at most sign the owner out, which must stay possible without the token.
 */
export function requireActor(deps: AuthDeps, allowed: readonly ActorKind[], opts: { csrf?: boolean } = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const actor = resolveActor(deps, req);
    if (!actor) throw new ControlError("UNAUTHENTICATED", "valid credentials are required");
    // A viewer holds no credential, so anything beyond a permitted read asks for sign-in.
    if (actor.kind === "viewer" && (!allowed.includes("viewer") || req.method !== "GET")) {
      throw new ControlError("UNAUTHENTICATED", "sign in is required for this action");
    }
    if (!allowed.includes(actor.kind)) throw new ControlError("FORBIDDEN", `this endpoint is not available to ${actor.kind} credentials`);
    if ((actor.kind === "owner" || actor.kind === "guest") && MUTATING.has(req.method)) {
      assertOrigin(deps, req);
      const header = req.headers[CSRF_HEADER];
      if (opts.csrf !== false && (typeof header !== "string" || !safeEqualHex(sha256Hex(header), actor.csrfHash))) {
        throw new ControlError("FORBIDDEN", "missing or invalid anti-CSRF token");
      }
    }
    res.locals.actor = actor;
    next();
  };
}

export function actorOf(res: Response): Actor {
  return res.locals.actor as Actor;
}
