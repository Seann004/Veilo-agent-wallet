import { isIP } from "node:net";
import { immediate } from "@veilo/db";
import { isPublicAddress } from "@veilo/mcp-client";
import { num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { writeAudit } from "../ledger/events";
import { activeAgentPolicy, agentPermissions, type AgentRow } from "../ledger/workspace";
import { assertTaskLive, ownTask } from "./work";

/** Pages one task may open with the read-only browser. */
export const MAX_BROWSE_PAGES_PER_TASK = 3;

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|home|lan|intranet|corp)$/i;

/** Public http(s) page URLs only: no credentials, default ports, no local or literal private hosts. */
export function browseUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "only http and https pages can be opened";
  if (u.username || u.password) return "URLs with credentials are refused";
  if (u.port !== "") return "only default ports are allowed";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) ? !isPublicAddress(host) : LOCAL_NAMES.test(host) || !host.includes(".")) return "local and private hosts are refused";
  return null;
}

/**
 * Authorizes one read-only page visit before the runner opens it: the agent must be active with
 * browsing turned on in its active policy, the task must be running, the URL must be public, and
 * the task must have pages left. The audit keeps the host, not the full URL.
 */
export function browsePermit(ledger: Ledger, agent: AgentRow, body: { taskId: string; url: string }): { url: string; remaining: number } {
  const problem = browseUrlProblem(body.url);
  if (problem) throw new ControlError("POLICY_DENIED", `page refused: ${problem}`);
  return immediate(ledger.db, () => {
    const t = ownTask(ledger, agent.id, body.taskId);
    assertTaskLive(ledger, t);
    const policy = activeAgentPolicy(ledger, agent.id);
    if (agent.status !== "active" || !policy || policy.tier === "stopped") throw new ControlError("ACCOUNT_STOPPED", "this agent is not active");
    if (!agentPermissions(policy).allowBrowsing) throw new ControlError("POLICY_DENIED", "web browsing is off for this agent");
    const used = num((t as unknown as { browse_calls: bigint }).browse_calls);
    if (used >= MAX_BROWSE_PAGES_PER_TASK) throw new ControlError("BUDGET_EXCEEDED", "task page limit reached");
    const url = new URL(body.url).toString();
    ledger.db.prepare(`UPDATE task SET browse_calls = browse_calls + 1, updated_at_ms = ? WHERE id = ?`).run(ledger.now(), t.id);
    ledger.db.prepare(`INSERT OR IGNORE INTO browse_page (task_id, url, permitted_at_ms) VALUES (?, ?, ?)`).run(t.id, url, ledger.now());
    writeAudit(ledger, {
      workspaceId: t.workspace_id,
      scope: `agent:${agent.id}`,
      actorType: "worker",
      actorId: agent.id,
      action: "browse.page",
      policyResult: "allowed",
      details: { taskId: t.id, host: new URL(body.url).hostname, page: used + 1 },
    });
    return { url, remaining: MAX_BROWSE_PAGES_PER_TASK - used - 1 };
  });
}
