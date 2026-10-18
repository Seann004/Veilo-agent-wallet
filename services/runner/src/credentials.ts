import { existsSync, readFileSync, statSync } from "node:fs";
import type { AgentCredential } from "./worker";

/** Worker credential file: {"agents":[{"agentId","role","token"}]}. Tokens are never logged. */
export function loadCredentials(path: string | undefined): AgentCredential[] {
  if (!path || !existsSync(path)) return [];
  // Parser messages can quote file contents, which hold tokens; only fixed messages leave here.
  let parsed: { agents?: Array<Partial<AgentCredential>> } | null;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as { agents?: Array<Partial<AgentCredential>> } | null;
  } catch {
    throw new Error("worker credential file could not be read or is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || (parsed.agents !== undefined && !Array.isArray(parsed.agents))) {
    throw new Error("worker credential file has no agents list");
  }
  return (parsed.agents ?? []).flatMap((a) =>
    typeof a.agentId === "string" && typeof a.token === "string" && (a.role === "research" || a.role === "content" || a.role === "custom")
      ? [{ agentId: a.agentId, role: a.role, token: a.token }]
      : [],
  );
}

/**
 * The current credential set, reloaded when the file's modification time or size changes. A file
 * that cannot be read or parsed keeps the previous set, so a partial edit never stops running agents.
 */
export class CredentialWatcher {
  #creds: AgentCredential[] = [];
  #stamp = "";

  constructor(
    private readonly path: string | undefined,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  current(): AgentCredential[] {
    return this.#creds;
  }

  /** Re-reads the file if it changed. Returns the agents added and removed by this reload. */
  reload(): { added: AgentCredential[]; removed: AgentCredential[] } {
    const none = { added: [], removed: [] };
    let stamp = "missing";
    try {
      if (this.path && existsSync(this.path)) {
        const s = statSync(this.path);
        stamp = `${s.mtimeMs}:${s.size}`;
      }
    } catch {
      return none;
    }
    if (stamp === this.#stamp) return none;
    let next: AgentCredential[];
    try {
      next = loadCredentials(this.path);
    } catch {
      this.#stamp = stamp;
      this.log("worker credential file could not be read or parsed; keeping the current agents");
      return none;
    }
    this.#stamp = stamp;
    const key = (c: AgentCredential) => `${c.agentId}:${c.token}`;
    const before = new Set(this.#creds.map(key));
    const after = new Set(next.map(key));
    const added = next.filter((c) => !before.has(key(c)));
    const removed = this.#creds.filter((c) => !after.has(key(c)));
    this.#creds = next;
    return { added, removed };
  }

  /** Reloads every `intervalMs` and reports changes by agent ID and role only. */
  start(intervalMs = 5_000): () => void {
    const tick = () => {
      const { added, removed } = this.reload();
      const ids = (list: AgentCredential[]) => list.map((c) => `${c.role} ${c.agentId}`).join(", ");
      if (added.length > 0) this.log(`worker started for ${ids(added)}`);
      if (removed.length > 0) this.log(`worker stopped for ${ids(removed)}`);
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
