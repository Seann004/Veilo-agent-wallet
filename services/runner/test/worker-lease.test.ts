import { afterEach, describe, expect, it, vi } from "vitest";
import { runMira } from "../src/roles/mira";
import { runOnce } from "../src/worker";
import type { RoleOutcome } from "../src/roles/common";

vi.mock("../src/roles/mira", () => ({ runMira: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

async function holdJob(statuses: Array<number | "network">) {
  vi.useFakeTimers();
  let finish!: (value: RoleOutcome) => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(runMira).mockImplementation(async () => { started(); return new Promise<RoleOutcome>(resolve => { finish = resolve; }); });
  const heartbeats: Array<{ version: string }> = [];
  const completions: Array<{ version: string }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/claim")) return Response.json({ job: { id: "job", version: "1" }, task: { id: "task", limits: {} } });
    if (url.endsWith("/heartbeat")) {
      heartbeats.push(body);
      const status = statuses.shift() ?? 200;
      if (status === "network") throw new Error("connection reset");
      return Response.json(status === 200 ? { job: { version: "2" } } : { error: { code: "test" } }, { status });
    }
    if (url.endsWith("/complete")) { completions.push(body); return Response.json({ ok: true }); }
    throw new Error(`unexpected request ${url}`);
  };
  const pending = runOnce({ agentId: "agent", role: "content", token: "token" }, { controlUrl: "http://control.test", workerId: "worker", leaseMs: 3000, fetchPolicy: { approvedOrigins: [], localServiceOrigins: [] }, fetch });
  await running;
  return { pending, heartbeats, completions, finish: () => finish({ taskState: "completed", summary: { artifactId: "saved-answer" } }) };
}

describe("runner lease heartbeats", () => {
  it("completes with the updated version after a 503 then a successful heartbeat", async () => {
    const run = await holdJob([503, 200]);
    await vi.advanceTimersByTimeAsync(2000);
    run.finish();
    await run.pending;
    expect(run.heartbeats.map(b => b.version)).toEqual(["1", "1"]);
    expect(run.completions).toEqual([expect.objectContaining({ version: "2", outcome: "completed", result: expect.objectContaining({ artifactId: "saved-answer" }) })]);
  });

  it.each([503, 429, "network"] as const)("still attempts complete with the last known version after %s", async status => {
    const run = await holdJob([status]);
    await vi.advanceTimersByTimeAsync(1000);
    run.finish();
    await run.pending;
    expect(run.completions).toEqual([expect.objectContaining({ version: "1" })]);
  });

  it.each([409, 404, 403])("latches definitive rejection %s and stops heartbeat and completion", async status => {
    const run = await holdJob([status, 200]);
    await vi.advanceTimersByTimeAsync(3000);
    run.finish();
    await run.pending;
    expect(run.heartbeats).toHaveLength(1);
    expect(run.completions).toEqual([]);
  });
});
