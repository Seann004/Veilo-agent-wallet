import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AGENTS } from "@veilo/contracts";
import { browseLanded, browsePermit, browseUrlProblem, MAX_BROWSE_PAGES_PER_TASK } from "../src/agents/browse";
import { validateResearchCitations } from "../src/agents/work";
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

describe("landed pages after a redirect", () => {
  function setup(key: string) {
    env = createEnv();
    activateDefaults(env, { agents: { Prince: { ...prince(), allowBrowsing: true } } });
    const agent = getAgent(env.ledger, env.agents.Prince.id)!;
    const task = runningTask(env, key);
    browsePermit(env.ledger, agent, { taskId: task, url: "https://CoinGecko.com/en/coins/thetanuts" });
    return { agent, task };
  }
  const brief = (task: string, content: string, citations: Array<{ url: string }> = []) => ({ taskId: task, content, citations, sourcePurchaseIds: [] });

  it("lets a brief cite the URL a permitted page landed on, and still refuses unrelated links", () => {
    const { agent, task } = setup("landed");
    expect(browseLanded(env.ledger, agent, { taskId: task, permittedUrl: "https://coingecko.com/en/coins/thetanuts", finalUrl: "https://www.coingecko.com/en/coins/thetanuts" }).url).toBe(
      "https://www.coingecko.com/en/coins/thetanuts",
    );
    const ok = "Price below.\n\nWeb pages read (read-only):\n- https://www.coingecko.com/en/coins/thetanuts/: https://www.coingecko.com/en/coins/thetanuts\n- also https://COINGECKO.com/en/coins/thetanuts.";
    expect(() => validateResearchCitations(env.ledger, agent.id, brief(task, ok, [{ url: "https://www.coingecko.com/en/coins/thetanuts/" }]))).not.toThrow();
    expect(() => validateResearchCitations(env.ledger, agent.id, brief(task, `${ok}\nhttps://evil.example/x`))).toThrow(/not purchased evidence/);
    expect(() => validateResearchCitations(env.ledger, agent.id, brief(task, ok, [{ url: "https://www.coingecko.com/en/coins/other" }]))).toThrow(/permitted page/);
    expect(env.db.prepare("SELECT browse_calls FROM task WHERE id = ?").pluck().get(task)).toBe(1n);
  });

  it("refuses a landing for a page that was never permitted, a private landing and a second landing", () => {
    const { agent, task } = setup("landed-refusals");
    expect(() => browseLanded(env.ledger, agent, { taskId: task, permittedUrl: "https://solana.com/docs", finalUrl: "https://solana.com/docs/x" })).toThrow(/not permitted/);
    expect(() => browseLanded(env.ledger, agent, { taskId: task, permittedUrl: "https://coingecko.com/en/coins/thetanuts", finalUrl: "http://127.0.0.1/admin" })).toThrow(/private/);
    browseLanded(env.ledger, agent, { taskId: task, permittedUrl: "https://coingecko.com/en/coins/thetanuts", finalUrl: "https://www.coingecko.com/a" });
    expect(browseLanded(env.ledger, agent, { taskId: task, permittedUrl: "https://coingecko.com/en/coins/thetanuts", finalUrl: "https://www.coingecko.com/a" }).url).toBe("https://www.coingecko.com/a");
    expect(() => browseLanded(env.ledger, agent, { taskId: task, permittedUrl: "https://coingecko.com/en/coins/thetanuts", finalUrl: "https://www.coingecko.com/b" })).toThrow(/already recorded/);
    // A landed URL is not itself a permit to record further landings.
    expect(() => browseLanded(env.ledger, agent, { taskId: task, permittedUrl: "https://www.coingecko.com/a", finalUrl: "https://www.coingecko.com/c" })).toThrow(/not permitted/);
    const audit = env.db.prepare("SELECT group_concat(details_json) FROM audit_event WHERE action = 'browse.landed'").pluck().get() as string;
    expect(audit).toContain("www.coingecko.com");
    expect(audit).not.toContain("/a");
  });
});
