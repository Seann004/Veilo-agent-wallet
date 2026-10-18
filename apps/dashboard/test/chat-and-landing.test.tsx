// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bot-avatars", () => ({
  botAvatarTypes: ["clover", "flower", "star"],
  BotAvatar: (props: { type: string; paused?: boolean }) => <canvas data-testid="bot" data-type={props.type} data-paused={String(!!props.paused)} />,
}));
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => <canvas /> }));
vi.mock("next/navigation", () => ({ usePathname: () => `/agents/x`, useParams: () => ({}) }));

import { AgentDetail, afterCutoff } from "../components/AgentDetail";
import { Landing } from "../components/Landing";
import { DetailHeader, creatorAvatar } from "../components/market/parts";
import { AVATARS } from "../lib/avatar-options";
import { withRole } from "./access-fixtures";
import { balancesAfterTopUpAndConsumption, PRINCE, purchase, recordingFetch } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try { window.localStorage.clear(); } catch { /* ignore */ }
});

const AT = "2026-10-15T00:00:00.000Z";
const TASK = "88888888-8888-4888-8888-888888888888";
const RUN = "20000000-0000-4000-8000-000000000009";

describe("marketplace avatars", () => {
  it("renders a paused bot, stable per name", () => {
    expect(creatorAvatar("Carousel")).toBe(creatorAvatar("Carousel"));
    render(<DetailHeader avatar={creatorAvatar("Carousel")} title="Carousel" by="Veilo" summary="s" />);
    const bot = screen.getByTestId("bot");
    expect(bot.getAttribute("data-paused")).toBe("true");
    expect(document.querySelector("img")).toBeNull();
    expect(AVATARS.length).toBeGreaterThan(0);
  });
});

describe("landing page", () => {
  it("shows seven bots with at most three animated, three features and three steps", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
    render(<Landing />);
    const hero = screen.getByLabelText("Example agents");
    const bots = hero.querySelectorAll("canvas");
    expect(bots.length).toBe(7);
    expect([...bots].filter((b) => b.getAttribute("data-paused") === "false").length).toBe(3);
    expect(screen.getByRole("heading", { name: "Private pool payments" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Per-agent limits" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Hire and run workflows" })).toBeTruthy();
    expect(document.querySelectorAll(".steps li").length).toBe(3);
  });

  it("pauses every bot under reduced motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
    render(<Landing />);
    expect([...screen.getByLabelText("Example agents").querySelectorAll("canvas")].every((b) => b.getAttribute("data-paused") === "true")).toBe(true);
  });
});

describe("afterCutoff", () => {
  it("keeps only entries after the cutoff, and everything without one", () => {
    const e = [{ at: "2026-10-15T00:00:00.000Z" }, { at: "2026-10-16T00:00:00.000Z" }];
    expect(afterCutoff(e, null)).toHaveLength(2);
    expect(afterCutoff(e, "2026-10-15T12:00:00.000Z")).toEqual([e[1]]);
    expect(afterCutoff(e, "garbage")).toHaveLength(2);
  });
});

function setup(runStatus: string) {
  const task = { id: TASK, agentId: PRINCE, objective: "Make a carousel", input: {}, state: "completed", deadline: null, startedAt: AT, limits: { taskUsdc: "0", taskUsageUnits: "0", maxToolCalls: 8, maxPaidPurchases: 3, maxPlanningCalls: 2 }, used: { toolCalls: 0, paidPurchases: 0, planningCalls: 0 }, createdAt: AT, updatedAt: AT, progress: [] };
  const job = { id: "job-1", agentId: PRINCE, taskId: TASK, kind: "custom", state: "completed", result: { workflowRun: { runId: RUN, status: "completed", title: "Carousel" } }, scheduledAt: AT, createdAt: AT, updatedAt: AT, attempts: 1 };
  const buys = ["a", "b", "c"].map((n, i) => purchase({ id: `6666666${i}-6666-4666-8666-666666666666`, agentId: PRINCE, taskId: TASK, price: { amount: n === "a" ? "100000" : "65000" }, createdAt: "2026-10-15T00:10:00.000Z" }));
  const rec = recordingFetch((url) => {
    if (url.includes("/tasks?")) return { tasks: [task], jobs: [job] };
    if (url.includes("/balances")) return balancesAfterTopUpAndConsumption();
    if (url.includes("/activity")) return { events: [], purchases: buys };
    if (url.includes(`/workflows/runs/${RUN}`)) return { run: { id: RUN, status: runStatus, steps: [] } };
    return { items: [] };
  });
  vi.stubGlobal("fetch", rec.impl);
}

describe("agent chat", () => {
  it("collapses a completed run's payments into one summary line", async () => {
    setup("completed");
    await act(async () => { render(withRole(<AgentDetail agentId={PRINCE} />)); });
    expect(screen.getByText(/Workflow run · 3 payments · 0\.23 USDC/)).toBeTruthy();
    expect(screen.queryAllByText(/Hire a specialist|Inference/i).length).toBe(0);
  });

  it("lists each payment while the run is not complete", async () => {
    setup("running");
    await act(async () => { render(withRole(<AgentDetail agentId={PRINCE} />)); });
    expect(screen.queryByText(/Workflow run · 3 payments/)).toBeNull();
    expect(screen.getAllByRole("button", { name: /USDC/ }).length).toBeGreaterThanOrEqual(3);
  });

  it("New chat hides earlier entries per agent and Show earlier messages restores them", async () => {
    setup("running");
    await act(async () => { render(withRole(<AgentDetail agentId={PRINCE} />)); });
    expect(screen.getByText("Make a carousel")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "New chat" })); });
    expect(screen.queryByText("Make a carousel")).toBeNull();
    expect(window.localStorage.getItem(`veilo:chat-cutoff:${PRINCE}`)).not.toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Show earlier messages" })); });
    expect(screen.getByText("Make a carousel")).toBeTruthy();
    expect(window.localStorage.getItem(`veilo:chat-cutoff:${PRINCE}`)).toBeNull();
  });
});
