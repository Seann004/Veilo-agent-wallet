import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialWatcher } from "../src/credentials";
import { startWorker } from "../src/worker";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function write(path: string, agents: unknown[], mtime: number): void {
  writeFileSync(path, JSON.stringify({ agents }));
  utimesSync(path, mtime, mtime);
}

describe("worker credential reload", () => {
  it("adds and removes agents when the file changes, and keeps the set on a bad write", () => {
    dir = mkdtempSync(join(tmpdir(), "veilo-runner-creds-"));
    const path = join(dir, "worker-credentials.json");
    const logs: string[] = [];
    const w = new CredentialWatcher(path, (l) => logs.push(l));
    expect(w.reload()).toEqual({ added: [], removed: [] });
    expect(w.current()).toEqual([]);

    write(path, [{ agentId: A, role: "research", token: "vwk_a" }], 1_000);
    expect(w.reload().added.map((c) => c.agentId)).toEqual([A]);
    expect(w.reload()).toEqual({ added: [], removed: [] });

    write(path, [{ agentId: A, role: "research", token: "vwk_a" }, { agentId: B, role: "custom", token: "vwk_b" }, { agentId: "x", role: "credit_manager", token: "vwk_x" }], 2_000);
    expect(w.reload().added.map((c) => c.agentId)).toEqual([B]);
    expect(w.current().map((c) => c.agentId)).toEqual([A, B]);

    writeFileSync(path, "{ not json");
    utimesSync(path, 3_000, 3_000);
    expect(w.reload()).toEqual({ added: [], removed: [] });
    expect(w.current().map((c) => c.agentId)).toEqual([A, B]);

    write(path, [{ agentId: B, role: "custom", token: "vwk_b" }], 4_000);
    expect(w.reload().removed.map((c) => c.agentId)).toEqual([A]);
    for (const l of logs) expect(l).not.toMatch(/vwk_/);
  });

  it("starts claiming for an agent added to the file without a restart", async () => {
    dir = mkdtempSync(join(tmpdir(), "veilo-runner-creds-"));
    const path = join(dir, "worker-credentials.json");
    write(path, [{ agentId: A, role: "research", token: "vwk_a" }], 1_000);
    const w = new CredentialWatcher(path);
    w.reload();
    const claimsBy: string[] = [];
    const fetch = async (_url: string, init?: RequestInit) => {
      claimsBy.push(String((init?.headers as Record<string, string>).authorization));
      return new Response(null, { status: 204 });
    };
    const stop = startWorker(() => w.current(), { controlUrl: "http://control.test", workerId: "w", fetchPolicy: { approvedOrigins: [], localServiceOrigins: [] }, fetch }, 10);
    try {
      await new Promise((r) => setTimeout(r, 40));
      expect(claimsBy).toContain("Bearer vwk_a");
      expect(claimsBy).not.toContain("Bearer vwk_b");
      write(path, [{ agentId: A, role: "research", token: "vwk_a" }, { agentId: B, role: "custom", token: "vwk_b" }], 2_000);
      w.reload();
      await new Promise((r) => setTimeout(r, 40));
      expect(claimsBy).toContain("Bearer vwk_b");
    } finally {
      stop();
    }
  });
});
