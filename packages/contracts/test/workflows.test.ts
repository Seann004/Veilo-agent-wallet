import { describe, expect, it } from "vitest";
import {
  checkWorkflowPublication,
  PROVIDER_MANIFESTS,
  toolManifestSchema,
  stepQuoteProblem,
  toolKey,
  toolManifestDigest,
  workflowApprovalDigest,
  workflowVersionInputSchema,
  type ToolFacts,
  type WorkflowApprovalTerms,
  type WorkflowVersionInput,
} from "../src/marketplace";

const DATA = "11111111-1111-4111-8111-111111111111";
const BRIEF = "22222222-2222-4222-8222-222222222222";
const DRAFT = "33333333-3333-4333-8333-333333333333";
const PAYOUT = "44444444-4444-4444-8444-444444444444";
const R1 = "2LWbc9Mi6dRUrdEHBttoNS4udDtH1A4xwBdm1EKqcT57";
const R2 = "CPZSjRmyfTS95UjQD8ZdeTEWbQvW9QvEXnn6aGP7yyMN";

function tool(id: string, over: Partial<ToolFacts> = {}): ToolFacts {
  return {
    toolKind: id === DATA ? "external" : "listing",
    toolId: id,
    current: true,
    reviewStatus: "approved",
    listingStatus: "published",
    priceBaseUnits: 10_000n,
    recipient: R1,
    effect: "read_only",
    io: { inputs: [{ name: "query", kind: "text", required: true, maxChars: 1000 }], output: { kind: "json" } },
    ...over,
  };
}

function tools(...t: ToolFacts[]): Map<string, ToolFacts> {
  return new Map(t.map((x) => [toolKey(x.toolKind, x.toolId), x]));
}

const base = (): WorkflowVersionInput =>
  workflowVersionInputSchema.parse({
    category: "research",
    title: "Token brief",
    summary: "Buys on-chain data, then writes a cited brief.",
    description: "Two paid steps: data, then a brief that cites each purchased response.",
    safetyPromise: "",
    runInputs: [{ name: "mint", label: "Token mint", maxChars: 64 }],
    steps: [
      { toolKind: "external", toolId: DATA, maxBaseUnits: "3000", inputs: { query: { from: "run_input", name: "mint" } } },
      { toolKind: "listing", toolId: BRIEF, maxBaseUnits: "10000", inputs: { query: { from: "step", step: 0 } } },
    ],
    totalMaxBaseUnits: "13000",
    payoutVersionId: PAYOUT,
    sampleOutput: null,
  });

const facts = () =>
  tools(
    tool(DATA, { priceBaseUnits: 3000n }),
    tool(BRIEF, { io: { inputs: [{ name: "query", kind: "text", required: true, maxChars: 8000 }], output: { kind: "markdown" } } }),
  );

describe("workflow publication checks (§26.7)", () => {
  it("goes live immediately when every step is an approved, current, published tool", () => {
    expect(checkWorkflowPublication(base(), facts(), true)).toEqual({ problems: [], decision: "live" });
  });

  it("goes to review when a step's tool is still in review", () => {
    const f = facts();
    f.set(`listing:${BRIEF}`, { ...f.get(`listing:${BRIEF}`)!, reviewStatus: "pending", listingStatus: "in_review", current: false });
    expect(checkWorkflowPublication(base(), f, true).decision).toBe("review");
  });

  it("rejects superseded, suspended or unknown tools", () => {
    const superseded = facts();
    superseded.set(`external:${DATA}`, { ...superseded.get(`external:${DATA}`)!, current: false });
    expect(checkWorkflowPublication(base(), superseded, true).problems).toContain("step 0: tool version is unpublished or superseded");
    const suspended = facts();
    suspended.set(`external:${DATA}`, { ...suspended.get(`external:${DATA}`)!, listingStatus: "suspended" });
    expect(checkWorkflowPublication(base(), suspended, true).decision).toBe("rejected");
    expect(checkWorkflowPublication(base(), tools(tool(BRIEF)), true).problems).toContain("step 0: tool version not found");
  });

  it("requires each maximum to equal the published price and the total to be their sum", () => {
    const w = base();
    w.steps[0]!.maxBaseUnits = "5000";
    expect(checkWorkflowPublication(w, facts(), true).problems).toEqual(
      expect.arrayContaining(["step 0: maximum must equal the tool's published price", "total must equal the sum of step maxima"]),
    );
    const cheap = base();
    cheap.steps[0]!.maxBaseUnits = "1000";
    cheap.totalMaxBaseUnits = "11000";
    expect(checkWorkflowPublication(cheap, facts(), true).problems).toContain("step 0: maximum must equal the tool's published price");
  });

  it("type-checks mappings and only allows earlier steps", () => {
    const f = facts();
    f.set(`listing:${BRIEF}`, { ...f.get(`listing:${BRIEF}`)!, io: { inputs: [{ name: "query", kind: "image_url", required: true, maxChars: 500 }], output: { kind: "markdown" } } });
    expect(checkWorkflowPublication(base(), f, true).problems).toContain("step 1: query expects image_url but step 0 produces json");
    const forward = base();
    forward.steps[0]!.inputs = { query: { from: "step", step: 1 } };
    expect(checkWorkflowPublication(forward, facts(), true).problems).toContain("step 0: query must come from an earlier step");
    const missing = base();
    missing.steps[1]!.inputs = {};
    expect(checkWorkflowPublication(missing, facts(), true).problems).toContain("step 1: required input query is not mapped");
    const undeclared = base();
    undeclared.steps[0]!.inputs = { query: { from: "run_input", name: "wallet" } };
    expect(checkWorkflowPublication(undeclared, facts(), true).problems).toContain("step 0: query maps an undeclared run input");
  });

  it("requires a verified payout and a safety promise for external drafting steps", () => {
    expect(checkWorkflowPublication(base(), facts(), false).problems).toContain("creator payout wallet is not verified");
    const w = base();
    w.steps.push({ toolKind: "listing", toolId: DRAFT, maxBaseUnits: "2000", inputs: { query: { from: "step", step: 1 } } });
    w.totalMaxBaseUnits = "15000";
    const f = facts();
    f.set(`listing:${DRAFT}`, tool(DRAFT, { priceBaseUnits: 2000n, effect: "draft_external", io: { inputs: [{ name: "query", kind: "text", required: true, maxChars: 2000 }], output: { kind: "draft_post" } } }));
    expect(checkWorkflowPublication(w, f, true).problems).toContain("a workflow with an external drafting or publishing step needs a safety promise");
    w.safetyPromise = "Drafts only; nothing posts without your approval.";
    expect(checkWorkflowPublication(w, f, true).decision).toBe("live");
  });

  it("requires a safety promise for an external publishing step", () => {
    const w = base();
    w.steps.push({ toolKind: "listing", toolId: DRAFT, maxBaseUnits: "2000", inputs: { query: { from: "step", step: 1 } } });
    w.totalMaxBaseUnits = "15000";
    const f = facts();
    f.set(`listing:${DRAFT}`, tool(DRAFT, { priceBaseUnits: 2000n, effect: "publish_external", io: { inputs: [{ name: "query", kind: "text", required: true, maxChars: 2000 }], output: { kind: "draft_post" } } }));
    expect(checkWorkflowPublication(w, f, true).problems).toContain("a workflow with an external drafting or publishing step needs a safety promise");
    w.safetyPromise = "Publishes publicly to the seller's TikTok account.";
    expect(checkWorkflowPublication(w, f, true).decision).toBe("live");
  });
});

describe("workflow approval terms", () => {
  const terms: WorkflowApprovalTerms = {
    workflowVersionId: "55555555-5555-4555-8555-555555555555",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    steps: [
      { toolKind: "external", toolId: DATA, recipient: R1, maxBaseUnits: "3000", toolDigest: "1".repeat(64) },
      { toolKind: "listing", toolId: BRIEF, recipient: R2, maxBaseUnits: "10000", toolDigest: "2".repeat(64) },
    ],
    totalMaxBaseUnits: "13000",
    runInputsDigest: "a".repeat(64),
  };
  const quote = { toolKind: "listing" as const, toolId: BRIEF, recipient: R2, totalBaseUnits: 10_000n, network: terms.network, mint: terms.mint };

  it("binds every term into the digest", () => {
    const d = workflowApprovalDigest(terms);
    expect(workflowApprovalDigest({ ...terms, totalMaxBaseUnits: "13001" })).not.toBe(d);
    expect(workflowApprovalDigest({ ...terms, steps: [terms.steps[0]!, { ...terms.steps[1]!, recipient: R1 }] })).not.toBe(d);
    expect(workflowApprovalDigest(structuredClone(terms))).toBe(d);
    expect(workflowApprovalDigest({ ...terms, steps: [{ ...terms.steps[0]!, toolDigest: "3".repeat(64) }, terms.steps[1]!] })).not.toBe(d);
  });

  it("halts on any changed price, recipient, tool version, network or mint", () => {
    expect(stepQuoteProblem(terms, 1, quote)).toBeNull();
    expect(stepQuoteProblem(terms, 1, { ...quote, totalBaseUnits: 10_001n })).toBe("step price changed");
    expect(stepQuoteProblem(terms, 1, { ...quote, totalBaseUnits: 9_999n })).toBe("step price changed");
    expect(stepQuoteProblem(terms, 1, { ...quote, recipient: R1 })).toBe("step recipient changed");
    expect(stepQuoteProblem(terms, 1, { ...quote, toolId: DATA })).toBe("step tool version changed");
    expect(stepQuoteProblem(terms, 1, { ...quote, toolKind: "external" })).toBe("step tool version changed");
    expect(stepQuoteProblem(terms, 1, { ...quote, mint: R1 })).toBe("step mint changed");
    expect(stepQuoteProblem(terms, 2, quote)).toBe("step is not part of the approved workflow");
  });

  it("digests a manifest canonically", () => {
    const m = {
      provider: "zernio" as const,
      adapterVersion: "1.0.0",
      upstream: "https://zernio.com/api/v1",
      tools: [{ name: "create_draft", effect: "draft_external" as const, io: { inputs: [{ name: "text", kind: "text" as const, required: true, maxChars: 2000 }], output: { kind: "draft_post" as const } } }],
    };
    expect(toolManifestDigest(m)).toMatch(/^[0-9a-f]{64}$/);
    expect(toolManifestDigest({ ...m, adapterVersion: "1.0.1" })).not.toBe(toolManifestDigest(m));
  });

  it("keeps the reviewed Higgsfield, MakeUGC and Zernio draft manifests unchanged", () => {
    // A change here disables every listing reviewed under these digests until it is reviewed again.
    expect(toolManifestDigest(PROVIDER_MANIFESTS.higgsfield)).toBe("7d134b902b57572ef5ea17a627ecd45f6f38d15032c880bb783db738452ccb3b");
    expect(toolManifestDigest(PROVIDER_MANIFESTS.makeugc)).toBe("7879703730329aec0d4be309738edce88674b4df348ed630e7cac40322c3c28b");
    expect(toolManifestDigest(PROVIDER_MANIFESTS.zernio)).toBe("e7de6ad95d22de9bb161e1c817dd3fb8b30eb8a933bde15f79289e5337e0b366");
  });

  it("declares the public publishing tool with the publish_external effect", () => {
    const tools = PROVIDER_MANIFESTS.zernio_publish.tools;
    expect(tools.map((t) => [t.name, t.effect])).toEqual([["publish_tiktok_carousel", "publish_external"]]);
    expect(PROVIDER_MANIFESTS.slides.tools.map((t) => [t.name, t.effect])).toEqual([["render_carousel_slides", "read_only"]]);
    for (const m of Object.values(PROVIDER_MANIFESTS)) expect(toolManifestSchema.parse(m)).toEqual(m);
  });
});
