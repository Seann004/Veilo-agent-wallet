import { afterEach, describe, expect, it } from "vitest";
import { MARKETPLACE_DELEGATION_DEPTH_KEY } from "@veilo/contracts";
import type { WorkflowRunner } from "../src/workflows/runner";
import { createTask } from "../src/ledger/summaries";
import { getAgent } from "../src/ledger/workspace";
import { FakeWorkflowMarket, fakeWorkflowRunner, WF_OWNER as OWNER, WF_V1 as V1, WF_V2 as V2 } from "./fixtures/fake-workflow-market";
import { makeStack, type Stack } from "./fixtures/stack";

let s: Stack | undefined;
let runner: WorkflowRunner | undefined;
afterEach(async () => {
  await s?.close();
  s = runner = undefined;
});

async function stack(): Promise<{ st: Stack; wf: WorkflowRunner; market: FakeWorkflowMarket }> {
  const market = new FakeWorkflowMarket();
  s = await makeStack({
    workflows: (ledger) => {
      runner = fakeWorkflowRunner(ledger, market);
      return runner;
    },
  });
  return { st: s, wf: runner as WorkflowRunner, market };
}

function runningTask(st: Stack, agent: "Mira" | "Prince", input: Record<string, unknown> = { [MARKETPLACE_DELEGATION_DEPTH_KEY]: 0 }, limitUsdc = 1_000_000): string {
  const id = createTask(st.env.ledger, { workspaceId: st.env.ws.id, agent: getAgent(st.env.ledger, st.env.agents[agent].id)!, objective: "make a carousel", input }).id;
  st.env.db.prepare(`UPDATE task SET state = 'running', started_at_ms = ?, limit_usdc = ?, max_purchases = 4 WHERE id = ?`).run(st.env.ledger.now(), limitUsdc, id);
  return id;
}

describe("worker workflow routes", () => {
  it("lists only this agent's active assignments, with the catalogue title and run inputs", async () => {
    const { st, wf } = await stack();
    const mira = st.env.agents.Mira.id;
    await wf.assign({ agentId: mira, versionId: V1, budgetUsdc: 500_000n, ownerPubkey: OWNER });
    await wf.assign({ agentId: st.env.agents.Prince.id, versionId: V2, budgetUsdc: 500_000n, ownerPubkey: OWNER });
    const headers = { authorization: `Bearer ${st.worker("Mira")}` };
    const listed = await st.call("/worker/workflows", { headers });
    expect(listed.status).toBe(200);
    expect(listed.body.workflows).toEqual([
      { versionId: V1, title: "Carousel from a topic", summary: "Researches a topic and drafts a carousel.", runInputs: [{ name: "topic", label: "Topic", maxChars: 500 }], total: "230000" },
    ]);
    st.env.db.prepare(`UPDATE workflow_assignment SET status = 'revoked' WHERE agent_id = ?`).run(mira);
    expect((await st.call("/worker/workflows", { headers })).body.workflows).toEqual([]);
    const prince = await st.call("/worker/workflows", { headers: { authorization: `Bearer ${st.worker("Prince")}` } });
    expect(prince.body.workflows.map((w: { versionId: string; title: string }) => [w.versionId, w.title])).toEqual([[V2, "Assigned workflow"]]);
  });

  it("returns the same run for a repeated key and refuses the key with different inputs", async () => {
    const { st, wf } = await stack();
    await wf.assign({ agentId: st.env.agents.Mira.id, versionId: V1, budgetUsdc: 500_000n, ownerPubkey: OWNER });
    const taskId = runningTask(st, "Mira");
    const headers = { authorization: `Bearer ${st.worker("Mira")}` };
    const body = { taskId, versionId: V1, runInputs: { topic: "Solana validators" }, idempotencyKey: `task:${taskId}:wfrun:${V1}` };
    const first = await st.call("/worker/workflow-runs", { method: "POST", headers, body });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: "approved", total: "230000" });
    const again = await st.call("/worker/workflow-runs", { method: "POST", headers, body });
    expect(again.body.runId).toBe(first.body.runId);
    const conflict = await st.call("/worker/workflow-runs", { method: "POST", headers, body: { ...body, runInputs: { topic: "Something else" } } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(st.count(`SELECT count(*) FROM workflow_run`)).toBe(1);
  });

  it("without an assignment the proposal waits for the owner", async () => {
    const { st, market } = await stack();
    const taskId = runningTask(st, "Mira");
    const r = await st.call("/worker/workflow-runs", { method: "POST", headers: { authorization: `Bearer ${st.worker("Mira")}` }, body: { taskId, versionId: V1, runInputs: { topic: "Solana validators" } } });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("awaiting_approval");
    expect(market.runs).toBe(0);
  });

  it("a specialist-depth task cannot start a workflow run", async () => {
    const { st } = await stack();
    const taskId = runningTask(st, "Mira", { [MARKETPLACE_DELEGATION_DEPTH_KEY]: 1 });
    const r = await st.call("/worker/workflow-runs", { method: "POST", headers: { authorization: `Bearer ${st.worker("Mira")}` }, body: { taskId, versionId: V1, runInputs: { topic: "x" } } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("POLICY_DENIED");
    expect(st.count(`SELECT count(*) FROM workflow_run`)).toBe(0);
  });

  it("refuses a run that does not fit the proposing task's budget, before any step pays", async () => {
    const { st, wf, market } = await stack();
    await wf.assign({ agentId: st.env.agents.Mira.id, versionId: V1, budgetUsdc: 500_000n, ownerPubkey: OWNER });
    const taskId = runningTask(st, "Mira", { [MARKETPLACE_DELEGATION_DEPTH_KEY]: 0 }, 100_000);
    const r = await st.call("/worker/workflow-runs", { method: "POST", headers: { authorization: `Bearer ${st.worker("Mira")}` }, body: { taskId, versionId: V1, runInputs: { topic: "x" } } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("BUDGET_EXCEEDED");
    expect(st.env.db.prepare(`SELECT status FROM workflow_run`).pluck().get()).toBe("rejected");
    expect(market.runs).toBe(0);
  });
});
