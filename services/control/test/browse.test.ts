import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "@veilo/contracts";
import { browsePermit, browseUrlProblem, MAX_BROWSE_PAGES_PER_TASK } from "../src/agents/browse";
import { getAgent, requireWorkAuthority } from "../src/ledger/workspace";
import { activateDefaults, createEnv, intentTask, type TestEnv } from "./helpers";

let env: TestEnv;
afterEach(() => env?.cleanup());

const prince = () => DEFAULT_AGENTS.find((a) => a.name === "Prince")!.policy;

function runningTask(e: TestEnv, key: string): string {
  const id = intentTask(e, e.agents.Prince.id, key);
  e.db.prepare("UPDATE task SET state = 'running' WHERE id = ?").run(id);
  return id;
}

describe("read-only browsing permits", () => {
  it("refuse non-public, credentialed or non-default-port URLs", () => {
    for (const bad of ["file:///etc/passwd", "http://localhost/", "http://127.0.0.1/", "http://10.0.0.5/x", "http://[::1]/", "https://user:pw@example.com/", "https://example.com:8443/", "http://intranet/", "http://printer.local/"]) {
      expect(browseUrlProblem(bad), bad).not.toBeNull();
    }
    expect(browseUrlProblem("https://solana.com/docs")).toBeNull();
  });

  it("are off by default, then bounded per task and audited by host only", () => {
    env = createEnv();
    activateDefaults(env);
    const agent = getAgent(env.ledger, env.agents.Prince.id)!;
    const off = runningTask(env, "off");
    expect(() => browsePermit(env.ledger, agent, { taskId: off, url: "https://solana.com/docs" })).toThrow(/browsing is off/);

    env = createEnv();
    activateDefaults(env, { agents: { Prince: { ...prince(), allowBrowsing: true } } });
    const on = getAgent(env.ledger, env.agents.Prince.id)!;
    const task = runningTask(env, "on");
    for (let i = 0; i < MAX_BROWSE_PAGES_PER_TASK; i += 1) {
      expect(browsePermit(env.ledger, on, { taskId: task, url: `https://solana.com/docs/page-${i}?q=secret-query` }).remaining).toBe(MAX_BROWSE_PAGES_PER_TASK - i - 1);
    }
    expect(() => browsePermit(env.ledger, on, { taskId: task, url: "https://solana.com/docs" })).toThrow(/page limit/);
    expect(() => browsePermit(env.ledger, on, { taskId: task, url: "http://169.254.169.254/latest/meta-data" })).toThrow(/private/);
    const audit = env.db.prepare("SELECT group_concat(details_json) FROM audit_event WHERE action = 'browse.page'").pluck().get() as string;
    expect(audit).toContain("solana.com");
    expect(audit).not.toContain("secret-query");
  });

  it("stop when the agent or workspace policy expires, like purchases do", () => {
    env = createEnv();
    const expiresAt = new Date(env.clock.t + 60_000).toISOString();
    activateDefaults(env, { agents: { Prince: { ...prince(), allowBrowsing: true, expiresAt } } });
    const agent = getAgent(env.ledger, env.agents.Prince.id)!;
    const task = runningTask(env, "expiry");
    expect(browsePermit(env.ledger, agent, { taskId: task, url: "https://solana.com/docs" }).remaining).toBe(MAX_BROWSE_PAGES_PER_TASK - 1);
    env.clock.t += 60_000;
    expect(() => browsePermit(env.ledger, agent, { taskId: task, url: "https://solana.com/docs/2" })).toThrow(/agent policy has expired/);
    expect(env.db.prepare("SELECT browse_calls FROM task WHERE id = ?").pluck().get(task)).toBe(1n);

    env = createEnv();
    activateDefaults(env, { workspace: { expiresAt: new Date(env.clock.t + 60_000).toISOString() } });
    const prince2 = getAgent(env.ledger, env.agents.Prince.id)!;
    expect(() => requireWorkAuthority(env.ledger, prince2)).not.toThrow();
    env.clock.t += 60_000;
    expect(() => requireWorkAuthority(env.ledger, prince2)).toThrow(/workspace policy has expired/);
  });
});
