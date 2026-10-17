import type { NextFunction, Request, Response } from "express";
import type { Ledger } from "../context";
import { ControlError } from "../errors";
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
  | { kind: "worker"; workspaceId: string; agentId: string; credentialId: string }
  | { kind: "service"; service: ServicePrincipal };

export type ActorKind = Actor["kind"];

export interface AuthDeps {
  ledger: Ledger;
  session: SessionSettings;
  services: ServiceCredentials;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

/**
 * Resolves the caller from exactly one credential: a bearer token (worker or service) or the
 * owner session cookie. Request bodies never contribute to identity.
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
    const s = authenticateSession(deps.ledger, cookie);
    if (s) return { kind: "owner", workspaceId: s.workspaceId, ownerPubkey: s.ownerPubkey, sessionId: s.id, csrfHash: s.csrfHash };
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

export function requireActor(deps: AuthDeps, allowed: readonly ActorKind[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const actor = resolveActor(deps, req);
    if (!actor) throw new ControlError("UNAUTHENTICATED", "valid credentials are required");
    if (!allowed.includes(actor.kind)) throw new ControlError("FORBIDDEN", `this endpoint is not available to ${actor.kind} credentials`);
    if (actor.kind === "owner" && MUTATING.has(req.method)) {
      assertOrigin(deps, req);
      const header = req.headers[CSRF_HEADER];
      if (typeof header !== "string" || !safeEqualHex(sha256Hex(header), actor.csrfHash)) {
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
