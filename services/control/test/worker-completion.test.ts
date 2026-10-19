import { afterEach, describe, expect, it } from "vitest";
import { makeStack, type Stack } from "./fixtures/stack";

let s: Stack | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

describe("worker completion lease authority", () => {
  it("refuses wrong workers, stale versions and expired leases without finishing the job", async () => {
    s = await makeStack();
    const st = s;
    const owner = await st.login();
    const run = await st.call(`/agents/${st.env.agents.Mira.id}/run`, { method: "POST", headers: st.ownerHeaders(owner), body: { input: { topic: "Repair cafes", audience: "Neighbours", channels: ["LinkedIn", "Newsletter", "Instagram"], voice: "Friendly", startDate: "2026-10-20" } } });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    const headers = { authorization: `Bearer ${st.worker("Mira")}` };
    const claim = await st.call("/worker/jobs/claim", { method: "POST", headers, body: { workerId: "worker-one", leaseMs: 30000 } });
    expect(claim.status).toBe(200);
    const { id, version } = claim.body.job;
    const complete = (workerId: string, v: string, auth = headers) => st.call(`/worker/jobs/${id}/complete`, { method: "POST", headers: auth, body: { workerId, version: v, outcome: "completed", taskState: "completed", result: {} } });
    expect((await complete("worker-two", version)).status).toBe(409);
    expect((await complete("worker-one", version, { authorization: `Bearer ${st.worker("Prince")}` })).status).toBe(403);
    const beat = await st.call(`/worker/jobs/${id}/heartbeat`, { method: "POST", headers, body: { workerId: "worker-one", version, leaseMs: 30000 } });
    expect(beat.status).toBe(200);
    expect((await complete("worker-one", version)).status).toBe(409);
    st.gw.clock.t += 30001;
    expect((await complete("worker-one", beat.body.job.version)).status).toBe(409);
    expect(st.env.db.prepare("SELECT state FROM job WHERE id = ?").get(id)).toEqual({ state: "leased" });
    expect(st.env.db.prepare("SELECT state FROM task WHERE id = ?").get(run.body.taskId)).toEqual({ state: "running" });
  });
});
