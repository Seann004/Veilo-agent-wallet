// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ list: [] as string[], run: null as unknown, artifact: null as unknown }));
vi.mock("next/navigation", () => ({ usePathname: () => "/marketplace/runs/r1", useParams: () => ({}) }));
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => <canvas /> }));
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  api: vi.fn(async (_s: string, path: string, opts?: { method?: string }) => {
    calls.list.push(`${opts?.method ?? "GET"} ${path}`);
    if (path.endsWith("/artifact")) return calls.artifact;
    return { run: calls.run };
  }),
}));
vi.mock("../lib/market/client", () => ({ marketApi: vi.fn(async () => ({ workflows: [] })) }));

import { WorkflowRunView } from "../components/market/WorkflowRuns";
import { ImageGallery } from "../components/market/RunOutput";
import { describeArtifact, postSentence } from "../lib/market/artifacts";
import { clearResourceCache } from "../components/hooks";

const step = (i: number, over: object = {}) => ({
  index: i, toolKind: "x", toolId: "t", recipient: "Recip1111111111111111111111111111111111111", max: "10000", state: "pending",
  payment: "not_paid", execution: "not_run", paid: null, jobId: null, purchaseId: null, fundingSignature: null, merchantSignatures: [], artifact: null, stop: null, ...over,
});
const baseRun = (status: string, steps: object[]) => ({
  id: "r1", cloudRunId: null, workflowVersionId: "v", agentId: "a", status, isTest: false, requestedBy: "owner", approvedBy: null, approvalDigest: "d",
  terms: { steps: [], totalMaxBaseUnits: "30000", network: "n", mint: "m" }, total: { amount: "30000", unit: "USDC" }, stop: null, waiting: null, steps,
});

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); calls.list = []; clearResourceCache(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("run view", () => {
  it("polls advance while running, renders the stepper, and stops once completed", async () => {
    calls.run = baseRun("running", [step(0, { payment: "paid", paid: "10000", execution: "delivered", state: "done" }), step(1), step(2)]);
    render(<WorkflowRunView runId="r1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.getByText(/Step 2 of 3/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check progress" })).toBeNull();
    const advances = () => calls.list.filter((c) => c.endsWith("/advance")).length;
    expect(advances()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(advances()).toBe(1);
    calls.run = baseRun("completed", [step(0), step(1), step(2)]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    const after = advances();
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(advances()).toBe(after);
  });

  it("does not poll a run that is not live", async () => {
    calls.run = baseRun("completed", [step(0)]);
    render(<WorkflowRunView runId="r1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(calls.list.some((c) => c.endsWith("/advance"))).toBe(false);
  });

  it("stops polling on unmount", async () => {
    calls.run = baseRun("running", [step(0)]);
    const { unmount } = render(<WorkflowRunView runId="r1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    unmount();
    const n = calls.list.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(calls.list.length).toBe(n);
  });
});

describe("outputs", () => {
  it("does not load images until asked, then loads https ones without referrer", async () => {
    const urls = ["https://img.example/a.png", "https://img.example/b.png"];
    const { container } = render(<ImageGallery images={urls} />);
    expect(container.querySelectorAll("img").length).toBe(0);
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole("button", { name: /Load images/ }));
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs.length).toBe(2);
    expect(imgs[0]!.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(imgs[0]!.getAttribute("loading")).toBe("lazy");
    expect(container.querySelector("a")!.getAttribute("target")).toBe("_blank");
  });

  it("drops non-https image URLs", () => {
    const v = describeArtifact("json", JSON.stringify({ images: ["http://x/a.png", "javascript:alert(1)", "https://x/b.png"], caption: "hi" }));
    expect(v).toEqual({ type: "gallery", images: ["https://x/b.png"], caption: "hi" });
  });

  it("describes Zernio drafts and published posts", () => {
    const draft = describeArtifact("draft_post", JSON.stringify({ platform: "tiktok", zernioPostId: "p1", slides: 2, state: "draft in the creator's TikTok inbox; publish it in the TikTok app" }));
    expect(draft.type === "post" && postSentence(draft)).toBe("Sent to TikTok inbox as a draft (2 slides)");
    const pub = describeArtifact("publish", JSON.stringify({ platform: "tiktok", zernioPostId: "p1", slides: 2, state: "published" }));
    expect(pub.type === "post" && postSentence(pub)).toBe("Posted to TikTok (2 slides)");
    expect(describeArtifact("other", "raw").type).toBe("plain");
  });
});
