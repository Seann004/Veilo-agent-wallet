import { afterEach, describe, expect, it } from "vitest";
import { createTask } from "../src/ledger/summaries";
import { getAgent } from "../src/ledger/workspace";
import { sanitizeProgressLabel } from "../src/agents/progress";
import { makeStack, type Stack } from "./fixtures/stack";

let s: Stack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

function task(st: Stack, agent: "Mira" | "Prince", state: "running" | "queued" = "running"): string {
  const id = createTask(st.env.ledger, { workspaceId: st.env.ws.id, agent: getAgent(st.env.ledger, st.env.agents[agent].id)!, objective: "research validators", input: {} }).id;
  if (state === "running") st.env.db.prepare(`UPDATE task SET state = 'running', started_at_ms = ? WHERE id = ?`).run(st.env.ledger.now(), id);
  return id;
}

describe("task progress labels", () => {
  it("keeps plain text: hosts instead of links, no tokens or long opaque runs, at most 120 characters", () => {
    expect(sanitizeProgressLabel("Reading page https://user:pw@docs.solana.com/path?q=secret#x")).toBe("Reading page docs.solana.com");
    expect(sanitizeProgressLabel("token vwk_abcDEF123 used")).toBe("token [redacted] used");
    expect(sanitizeProgressLabel(`key ${"A".repeat(44)} end`)).toBe("key [redacted] end");
    expect(sanitizeProgressLabel("line\nbreak\u0007 bell")).toBe("line break bell");
    const long = sanitizeProgressLabel("x ".repeat(200));
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("worker task progress route", () => {
  it("records steps only for the worker's own running task and shows the newest 20 to the owner", async () => {
    s = await makeStack();
    const st = s;
    const mira = { authorization: `Bearer ${st.worker("Mira")}` };
    const prince = { authorization: `Bearer ${st.worker("Prince")}` };
    const id = task(st, "Mira");

    const first = await st.call(`/worker/tasks/${id}/progress`, { method: "POST", headers: mira, body: { label: "Reading page https://example.com/a/b" } });
    expect(first.status).toBe(201);
    expect(first.body.label).toBe("Reading page example.com");

    expect((await st.call(`/worker/tasks/${id}/progress`, { method: "POST", headers: prince, body: { label: "spoof" } })).status).toBe(403);
    expect((await st.call(`/worker/tasks/${id}/progress`, { method: "POST", body: { label: "anon" } })).status).toBe(401);
    expect((await st.call(`/worker/tasks/${id}/progress`, { method: "POST", headers: mira, body: { label: "x", extra: 1 } })).status).toBe(400);
    expect((await st.call(`/worker/tasks/${id}/progress`, { method: "POST", headers: mira, body: { label: "   " } })).status).toBe(400);
    const queued = task(st, "Mira", "queued");
    expect((await st.call(`/worker/tasks/${queued}/progress`, { method: "POST", headers: mira, body: { label: "early" } })).status).toBe(403);

    for (let i = 0; i < 25; i++) {
      expect((await st.call(`/worker/tasks/${id}/progress`, { method: "POST", headers: mira, body: { label: `Step ${i}` } })).status).toBe(201);
    }
    expect(st.count(`SELECT count(*) FROM task_progress WHERE task_id = ?`, id)).toBe(20);

    const owner = await st.login();
    const list = await st.call(`/tasks?agentId=${st.env.agents.Mira.id}`, { headers: st.ownerHeaders(owner) });
    expect(list.status).toBe(200);
    const view = list.body.tasks.find((t: { id: string }) => t.id === id);
    expect(view.progress).toHaveLength(20);
    expect(view.progress[0].label).toBe("Step 5");
    expect(view.progress[19].label).toBe("Step 24");
    expect(typeof view.progress[0].at).toBe("string");
    expect(list.body.tasks.find((t: { id: string }) => t.id === queued).progress).toEqual([]);
  });
});
