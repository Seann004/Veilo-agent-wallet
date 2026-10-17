import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { lifetimeUsage } from "../src/ledger/accounting";
import { activateDefaults, addNotes, addService, createEnv, digest, type TestEnv } from "./helpers";

const WORKER = fileURLToPath(new URL("./fixtures/race-worker.ts", import.meta.url));
const CONTROL_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Outcome = { ok: true; purchaseId: string; created: boolean } | { ok: false; code: string };

/** Starts every process, waits until all are ready, then releases them at once. */
async function race(args: string[][]): Promise<Outcome[]> {
  const children: ChildProcess[] = args.map((a) =>
    fork(WORKER, a, { cwd: CONTROL_ROOT, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] }),
  );
  const ready = children.map(
    (c) => new Promise<void>((resolve, reject) => {
      c.once("message", () => resolve());
      c.once("exit", (code) => reject(new Error(`worker exited early (${code})`)));
    }),
  );
  await Promise.all(ready);
  const results = children.map(
    (c) => new Promise<Outcome>((resolve) => c.once("message", (m) => resolve(m as Outcome))),
  );
  for (const c of children) c.send("go");
  return Promise.all(results);
}

let env: TestEnv;
afterEach(() => env?.cleanup());

describe("CAP-02 concurrent authorizations racing for the final allowance", () => {
  it("admits only the exposure the workspace allowance permits across separate processes", async () => {
    env = createEnv();
    activateDefaults(env, { workspace: { lifetimeTestUsdc: "600000" } });
    const svc = addService(env, [
      { sku: "research-basic", paymentPath: "private_x402", price: 300_000n },
      { sku: "analyze", paymentPath: "private_x402", price: 300_000n },
    ]);
    addNotes(env, Array.from({ length: 8 }, () => 300_000n));
    const args: string[][] = [];
    for (let i = 0; i < 4; i++) {
      args.push([env.dbPath, env.ws.id, env.agents.Prince.id, svc, "research-basic", `prince-${i}`, digest(`p${i}`)]);
      args.push([env.dbPath, env.ws.id, env.agents.Mira.id, svc, "analyze", `mira-${i}`, digest(`m${i}`)]);
    }
    const outcomes = await race(args);
    const admitted = outcomes.filter((o) => o.ok);
    const denied = outcomes.filter((o): o is { ok: false; code: string } => !o.ok);
    expect(admitted).toHaveLength(2);
    expect(denied.map((d) => d.code)).toEqual(Array(6).fill("BUDGET_EXCEEDED"));
    const usage = lifetimeUsage(env.ledger, { kind: "workspace", id: env.ws.id }, "usdc", 600_000n);
    expect(usage.reserved).toBe(600_000n);
    expect(Number(env.db.prepare("SELECT count(*) FROM purchase").pluck().get())).toBe(2);
    expect(Number(env.db.prepare("SELECT count(*) FROM note WHERE state = 'reserved'").pluck().get())).toBe(2);
  }, 120_000);

  it("creates one operation when the same logical purchase races itself", async () => {
    env = createEnv();
    activateDefaults(env);
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, Array.from({ length: 6 }, () => 100_000n));
    const args = Array.from({ length: 5 }, () => [env.dbPath, env.ws.id, env.agents.Prince.id, svc, "research-basic", "same-episode", digest("same")]);
    const outcomes = await race(args);
    expect(outcomes.every((o) => o.ok)).toBe(true);
    const ids = new Set(outcomes.map((o) => (o.ok ? o.purchaseId : "")));
    expect(ids.size).toBe(1);
    expect(outcomes.filter((o) => o.ok && o.created)).toHaveLength(1);
    expect(Number(env.db.prepare("SELECT count(*) FROM reservation").pluck().get())).toBe(1);
  }, 120_000);
});
