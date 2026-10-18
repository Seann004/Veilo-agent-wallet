import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ledger } from "../context";
import { issueWorkerCredential } from "./credentials";
import { sha256Hex } from "./session";

/** Agent roles the runner executes; the credit manager runs inside control. */
const RUNNER_ROLES = ["research", "content", "custom"] as const;

interface FileEntry {
  agentId?: unknown;
  token?: unknown;
  [k: string]: unknown;
}

interface AgentLite {
  id: string;
  workspace_id: string;
  name: string;
  role: string;
  status: string;
}

export interface SyncResult {
  added: string[];
  removed: string[];
}

/**
 * Keeps the single-host runner credential file in line with the ledger: every active runner-role
 * agent gets one live worker credential, and revoked or archived agents lose their entry. Entries
 * for agents this ledger does not know are left untouched. Tokens are written only to the file
 * (0600, replaced by rename) and never logged.
 */
export class RunnerCredentialProvisioner {
  constructor(private readonly o: { ledger: Ledger; path: string; log?: (line: string) => void }) {}

  sync(): SyncResult {
    const { ledger, path } = this.o;
    const file = readFile(path);
    const agents = ledger.db
      .prepare(`SELECT id, workspace_id, name, role, status FROM agent WHERE role IN (${RUNNER_ROLES.map(() => "?").join(", ")})`)
      .all(...RUNNER_ROLES) as AgentLite[];
    const byId = new Map(agents.map((a) => [a.id, a]));
    const live = ledger.db.prepare(`SELECT 1 FROM worker_credential WHERE token_hash = ? AND agent_id = ? AND revoked_at_ms IS NULL`);

    const kept: FileEntry[] = [];
    const covered = new Set<string>();
    const removed: string[] = [];
    for (const e of file.agents) {
      const agent = typeof e.agentId === "string" ? byId.get(e.agentId) : undefined;
      if (agent && (agent.status === "revoked" || agent.status === "archived")) {
        removed.push(agent.id);
        continue;
      }
      // A stale token for an active agent is replaced; it can no longer authenticate.
      if (agent && agent.status === "active" && (typeof e.token !== "string" || !live.get(sha256Hex(e.token), agent.id))) {
        removed.push(agent.id);
        continue;
      }
      if (agent) covered.add(agent.id);
      kept.push(e);
    }

    const issued: Array<{ credentialId: string; entry: FileEntry }> = [];
    for (const a of agents) {
      if (a.status !== "active" || covered.has(a.id)) continue;
      const { credentialId, token } = issueWorkerCredential(ledger, a.workspace_id, a.id, "runner-provisioning", "system");
      issued.push({ credentialId, entry: { agentId: a.id, name: a.name, role: a.role, token } });
    }
    const added = issued.map((i) => i.entry.agentId as string);
    const reissued = new Set(added);
    const result = { added, removed: removed.filter((id) => !reissued.has(id)) };
    if (issued.length === 0 && removed.length === 0) return result;

    try {
      writeAtomically(path, `${JSON.stringify({ ...file.rest, agents: [...kept, ...issued.map((i) => i.entry)] }, null, 2)}\n`);
    } catch (error) {
      // A credential that never reached the runner must not stay usable.
      const revoke = ledger.db.prepare(`UPDATE worker_credential SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL`);
      for (const i of issued) revoke.run(ledger.now(), i.credentialId);
      throw error;
    }
    if (result.added.length > 0) this.o.log?.(`runner credentials provisioned for ${result.added.length} agent(s)`);
    if (result.removed.length > 0) this.o.log?.(`runner credentials removed for ${result.removed.length} stopped agent(s)`);
    return result;
  }

  /** Runs `sync` for a request hook; a file problem is logged by name and never fails the caller. */
  syncQuietly(): void {
    try {
      this.sync();
    } catch (error) {
      this.o.log?.(`runner credential provisioning failed: ${(error as Error).name}: ${(error as Error).message}`);
    }
  }
}

function readFile(path: string): { agents: FileEntry[]; rest: Record<string, unknown> } {
  if (!existsSync(path)) return { agents: [], rest: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { agents?: unknown }).agents)) {
    throw new Error("runner credential file has no agents list; it was left unchanged");
  }
  const { agents, ...rest } = parsed as { agents: FileEntry[] };
  return { agents, rest };
}

function writeAtomically(path: string, contents: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
