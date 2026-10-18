import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { immediate } from "@veilo/db";
import type { Ledger } from "../context";
import { ControlError } from "../errors";
import { writeAudit, type ActorType } from "../ledger/events";
import { requireAgent } from "../ledger/workspace";
import { safeEqualHex, sha256Hex } from "./session";

export interface WorkerIdentity {
  credentialId: string;
  workspaceId: string;
  agentId: string;
}

/** Issues a per-agent worker token. Only its digest is stored; the token is returned once. */
export function issueWorkerCredential(
  ledger: Ledger,
  workspaceId: string,
  agentId: string,
  ownerId: string,
  actorType: ActorType = "owner",
): { credentialId: string; token: string } {
  return immediate(ledger.db, () => {
    const agent = requireAgent(ledger, workspaceId, agentId);
    if (agent.status === "revoked" || agent.status === "archived") {
      throw new ControlError("ACCOUNT_STOPPED", "cannot issue credentials for a revoked or archived agent");
    }
    const token = `vwk_${randomBytes(32).toString("base64url")}`;
    const credentialId = ledger.newId();
    ledger.db
      .prepare(
        `INSERT INTO worker_credential (id, token_hash, workspace_id, agent_id, agent_epoch, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(credentialId, sha256Hex(token), workspaceId, agentId, agent.revocation_epoch, ledger.now());
    writeAudit(ledger, {
      workspaceId,
      scope: `agent:${agentId}`,
      actorType,
      actorId: ownerId,
      action: "worker_credential.issue",
      policyResult: "not_applicable",
      details: { credentialId },
    });
    return { credentialId, token };
  });
}

/** The agent identity always comes from the credential row, never from request input. */
export function authenticateWorker(ledger: Ledger, token: string): WorkerIdentity | null {
  if (!token.startsWith("vwk_")) return null;
  const row = ledger.db
    .prepare(
      `SELECT c.id, c.workspace_id, c.agent_id, a.status FROM worker_credential c JOIN agent a ON a.id = c.agent_id
       WHERE c.token_hash = ? AND c.revoked_at_ms IS NULL`,
    )
    .get(sha256Hex(token)) as { id: string; workspace_id: string; agent_id: string; status: string } | undefined;
  if (!row || row.status === "revoked" || row.status === "archived") return null;
  return { credentialId: row.id, workspaceId: row.workspace_id, agentId: row.agent_id };
}

export type ServicePrincipal = "wallet" | "relayer";

/** Service-to-service credentials accepted by control. The gateway admin credential is not one of them. */
export class ServiceCredentials {
  private readonly digests: Array<{ service: ServicePrincipal; digest: string }>;

  constructor(entries: Array<{ service: ServicePrincipal; secret: string }>) {
    this.digests = entries.map((e) => ({ service: e.service, digest: sha256Hex(e.secret) }));
  }

  /**
   * Reads credential files by path. Contents are never logged; a missing file disables that
   * principal and is reported by name only.
   */
  static fromFiles(paths: Partial<Record<ServicePrincipal, string | undefined>>, warn: (msg: string) => void): ServiceCredentials {
    const entries: Array<{ service: ServicePrincipal; secret: string }> = [];
    for (const [service, path] of Object.entries(paths) as Array<[ServicePrincipal, string | undefined]>) {
      if (path === undefined) {
        warn(`${service} service credential path is not configured; that principal is disabled`);
        continue;
      }
      if (!existsSync(path)) {
        warn(`${service} service credential file is missing; that principal is disabled`);
        continue;
      }
      const secret = readFileSync(path, "utf8").trim();
      if (secret.length < 32) {
        warn(`${service} service credential is shorter than 32 characters; that principal is disabled`);
        continue;
      }
      entries.push({ service, secret });
    }
    return new ServiceCredentials(entries);
  }

  authenticate(token: string): ServicePrincipal | null {
    const digest = sha256Hex(token);
    for (const d of this.digests) if (safeEqualHex(d.digest, digest)) return d.service;
    return null;
  }
}
