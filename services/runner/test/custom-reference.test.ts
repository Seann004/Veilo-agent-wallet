import { afterEach, describe, expect, it } from "vitest";
import { issueWorkerCredential } from "../../control/src/auth/credentials";
import { AiService } from "../../control/src/ai/service";
import { ProviderKeyVault } from "../../control/src/ai/vault";
import { activatePolicyVersion, insertAgent } from "../../control/src/ledger/workspace";
import type { WorkflowRunner } from "../../control/src/workflows/runner";
import { FakeWorkflowMarket, fakeWorkflowRunner, WF_OWNER, WF_V1 } from "../../control/test/fixtures/fake-workflow-market";
import { makeStack, type Stack } from "../../control/test/fixtures/stack";
import { ControlClient } from "../src/control-client";
import { runCustom } from "../src/roles/custom";
import { runOnce } from "../src/worker";

let s: Stack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

// A PNG header followed by filler: control checks the type's magic bytes, not the full image.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3_000, 0x5a)]);
const IMAGE = `data:image/png;base64,${PNG.toString("base64")}`;
const STYLE = "Terracotta #c97b5a background, dark #1f1a17 bold sans serif text, centred layout with wide margins.";

interface ModelCall {
  messages: Array<{ role: string; content: unknown }>;
}

async function runWithImage(o: { styleReply?: Response; withStyleInput?: boolean; image?: unknown }) {
  const market = new FakeWorkflowMarket();
  if (o.withStyleInput !== false) market.runInputs = [{ name: "topic", label: "Topic", maxChars: 500 }, { name: "style", label: "Style", maxChars: 60 }];
  let runner: WorkflowRunner | undefined;
  const modelCalls: ModelCall[] = [];
  const fakeModel = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as ModelCall;
    modelCalls.push(body);
    const all = body.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    if (all.includes("visual design style")) return o.styleReply ?? new Response(JSON.stringify({ model: "glm-5.3-flash", choices: [{ message: { content: STYLE } }] }), { status: 200 });
    let text = "Own analysis.";
    if (all.includes("Assigned workflows (")) text = JSON.stringify({ listingId: null, workflowVersionId: WF_V1, runInputs: { topic: "Solana validators", style: "" }, brief: "" });
    else if (all.includes("You are an agent working for a workspace owner")) text = JSON.stringify({ connectorCalls: [], browse: [], searchQuery: null, swap: false });
    return new Response(JSON.stringify({ model: "glm-5.3-flash", choices: [{ message: { content: text } }] }), { status: 200 });
  };
  let ai: AiService | undefined;
  s = await makeStack({
    ai: (ledger) => (ai = new AiService(ledger, ProviderKeyVault.ephemeral(), fakeModel)),
    workflows: (ledger) => (runner = fakeWorkflowRunner(ledger, market)),
  });
  const st = s;
  ai!.set(st.env.ws.id, "owner", { provider: "openai_compatible", baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKey: "sk-test-key-123456", model: "glm-5.3-flash" });
  const policy = {
    tier: "bounded_automatic" as const,
    lifetimeTestUsdc: "1000000",
    rolling24hTestUsdc: "1000000",
    maxPurchaseTestUsdc: "500000",
    taskLimitTestUsdc: "500000",
    usageAllowanceUnits: "0",
    taskCreditUnits: "0",
    allowedSkus: ["specialist-job"],
    allowedPaymentPaths: ["private_x402" as const],
  };
  const agent = st.env.db.transaction(() => insertAgent(st.env.ledger, st.env.ws.id, { name: "Designer", role: "custom", template: "researcher", instructions: "Make carousels.", policy }, "owner")).immediate();
  activatePolicyVersion(st.env.ledger, st.env.ws.id, agent.id, 1, { type: "owner", id: "owner" });
  await runner!.assign({ agentId: agent.id, versionId: WF_V1, budgetUsdc: 500_000n, ownerPubkey: WF_OWNER });
  const owner = await st.login();
  const run = await st.call(`/agents/${agent.id}/run`, { method: "POST", headers: st.ownerHeaders(owner), body: { objective: "Make a carousel about Solana validators.", input: { referenceImage: o.image ?? IMAGE } } });
  if (run.status !== 202) return { st, run, agent, modelCalls, received: [] as string[], content: "", runs: [], done: null };
  const token = issueWorkerCredential(st.env.ledger, st.env.ws.id, agent.id, "owner").token;
  // Every reply control sends the runner, to prove the image never reaches it.
  const received: string[] = [];
  const recording = async (input: string, init?: RequestInit) => {
    const res = await fetch(input, init);
    const text = await res.text();
    received.push(text);
    return new Response(text, { status: res.status, headers: res.headers });
  };
  const done = await runOnce({ agentId: agent.id, role: "custom", token }, { controlUrl: st.base, workerId: "runner-test", fetchPolicy: { approvedOrigins: [], localServiceOrigins: [] }, now: () => st.gw.clock.t, fetch: recording });
  const content = st.env.db.prepare("SELECT r.content FROM artifact a JOIN artifact_revision r ON r.artifact_id = a.id WHERE a.task_id = ?").pluck().get(run.body.taskId) as string;
  const runs = st.env.db.prepare(`SELECT run_inputs_json FROM workflow_run`).all() as Array<{ run_inputs_json: string }>;
  return { st, run, agent, modelCalls, received, content, runs, done };
}

describe("custom agent with a reference image", () => {
  it("never hands the image to the runner and fills the workflow's style input from the model's description", async () => {
    const r = await runWithImage({});
    expect(r.run.status).toBe(202);
    const b64 = PNG.toString("base64");
    // Stored apart from the task input, which only flags that an image exists.
    const input = r.st.env.db.prepare("SELECT input_json FROM task WHERE id = ?").pluck().get(r.run.body.taskId) as string;
    expect(input).not.toContain(b64.slice(0, 200));
    expect(JSON.parse(input)).toMatchObject({ hasReferenceImage: true });
    expect(r.st.count("SELECT count(*) FROM task_attachment WHERE task_id = ?", r.run.body.taskId)).toBe(1);

    expect(r.received.length).toBeGreaterThan(3);
    for (const text of r.received) expect(text).not.toContain(b64.slice(0, 200));
    expect(r.received.some((t) => t.includes('"hasReferenceImage":true'))).toBe(true);

    // One multimodal call carried the image; the planning calls stayed text-only.
    const withImage = r.modelCalls.filter((c) => JSON.stringify(c).includes(b64.slice(0, 200)));
    expect(withImage).toHaveLength(1);
    expect(withImage[0]!.messages[1]!.content).toEqual([{ type: "text", text: expect.any(String) }, { type: "image_url", image_url: { url: IMAGE } }]);

    expect(r.runs).toHaveLength(1);
    const inputs = JSON.parse(r.runs[0]!.run_inputs_json) as { topic: string; style: string };
    expect(inputs.style).toBe(STYLE.slice(0, 60).trim());
    expect(inputs.topic).toBe("Solana validators");
    expect(r.content).toContain(`Style from your reference image: ${STYLE}`);
    expect(r.done!.outcome.summary).toMatchObject({ referenceStyle: true });
  });

  it("continues without the style when the model cannot read images", async () => {
    const r = await runWithImage({ styleReply: new Response("{}", { status: 400 }), withStyleInput: false });
    expect(r.done!.outcome.taskState).toBe("completed");
    expect(r.content).toMatch(/Note: Your reference image was not used \(INVALID_REQUEST: your model can.t read images/);
    expect(r.content).not.toContain("Style from your reference image");
  });

  it.each([
    ["an SVG", `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`],
    ["a GIF", `data:image/gif;base64,${Buffer.from("GIF89a").toString("base64")}`],
    ["mismatched bytes", `data:image/jpeg;base64,${PNG.toString("base64")}`],
  ])("refuses %s at task creation", async (_label, image) => {
    const r = await runWithImage({ image });
    expect(r.run.status).toBe(400);
    expect(r.run.body.error.code).toBe("INVALID_REQUEST");
    expect(r.st.count("SELECT count(*) FROM task_attachment")).toBe(0);
  });

  it("accepts a run body large enough for a 1.5 MB image but refuses a larger one", async () => {
    const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(1_572_864 - 8, 1)]);
    const ok = await runWithImage({ image: `data:image/png;base64,${big.toString("base64")}` });
    expect(ok.run.status).toBe(202);
    await ok.st.close();
    s = undefined;
    const tooBig = await runWithImage({ image: `data:image/png;base64,${Buffer.concat([big, Buffer.alloc(3)]).toString("base64")}` });
    expect(tooBig.run.status).toBe(400);
  });
});

describe("custom agent hire brief with a reference image", () => {
  const LISTING = "66666666-6666-4666-8666-666666666666";
  const TASK = "77777777-7777-4777-8777-777777777777";

  /** A control stand-in with one marketplace listing; it records the proposed hire. */
  async function proposeHire(o: { image: boolean; plannerBrief: string }) {
    const planner = ['{"searchQuery":"carousel designer"}', JSON.stringify({ listingId: LISTING, brief: o.plannerBrief })];
    const hires: Array<{ brief: string }> = [];
    const fake = async (input: string, init?: RequestInit) => {
      const path = input.replace("http://control.test", "");
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
      if (path.startsWith("/worker/planning")) return json(200, { label: "TEST planner", gateway: { outcome: { status: "succeeded", text: planner.shift() ?? "{}" } } });
      if (path.startsWith("/worker/catalog")) return json(200, { items: [], capabilities: { browse: false, workflows: 0 } });
      if (path.startsWith("/worker/connectors")) return json(200, { connectors: [] });
      if (path.startsWith("/worker/describe-reference")) return json(200, { style: STYLE });
      if (path.startsWith("/worker/marketplace/search")) {
        return json(200, { items: [{ listingId: LISTING, title: "Carousel design", summary: "Slides", description: null, sellerName: "Seller", priceBaseUnits: "1000", turnaroundMinutes: 5, inputHint: null, outputFormat: null }] });
      }
      if (path.startsWith("/worker/hires")) {
        hires.push(body as { brief: string });
        return json(202, { proposalId: "h1", state: "awaiting_approval" });
      }
      if (path.startsWith("/worker/artifacts")) return json(201, { id: "a1" });
      return json(200, {});
    };
    const client = new ControlClient({ baseUrl: "http://control.test", token: "unused", customTools: true, fetch: fake });
    await runCustom({
      client,
      taskId: TASK,
      agentId: "agent",
      task: { objective: "Make a carousel about Solana validators.", input: { instructions: "Make carousels." }, ...(o.image ? { hasReferenceImage: true } : {}) },
      bounds: { maxToolCalls: 12, maxPaidPurchases: 3, maxPlanningCalls: 3, deadlineMs: Number.MAX_SAFE_INTEGER },
      now: () => 0,
      notes: [],
      sleep: async () => {},
    });
    expect(hires).toHaveLength(1);
    return hires[0]!.brief;
  }

  it("adds the reference image's style to the specialist brief, with or without a planner brief", async () => {
    const line = `Visual style to match (described from the owner's reference image): ${STYLE}`;
    const planned = await proposeHire({ image: true, plannerBrief: "Design five slides." });
    expect(planned).toContain("Design five slides.");
    expect(planned).toContain(line);
    const unplanned = await proposeHire({ image: true, plannerBrief: "" });
    expect(unplanned).toContain("Make a carousel about Solana validators.");
    expect(unplanned).toContain(line);
  });

  it("keeps the style line within the brief limit", async () => {
    const brief = await proposeHire({ image: true, plannerBrief: "x".repeat(4_000) });
    expect(brief.length).toBeLessThanOrEqual(16_000);
    expect(brief.endsWith(STYLE)).toBe(true);
  });

  it("adds no style line when no image is attached", async () => {
    const brief = await proposeHire({ image: false, plannerBrief: "Design five slides." });
    expect(brief).not.toContain("Visual style to match");
    expect(brief).not.toContain(STYLE);
  });
});
