// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDetail } from "../components/AgentDetail";
import { runStatusLine } from "../lib/results";
import { withRole } from "./access-fixtures";
import { balancesAfterTopUpAndConsumption, draft, PRINCE, recordingFetch } from "./fixtures";

vi.mock("next/navigation", () => ({ usePathname: () => `/agents/${PRINCE}`, useParams: () => ({}) }));
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => <canvas data-testid="orb" /> }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const AT = "2026-10-15T00:00:00.000Z";
const TASK = "88888888-8888-4888-8888-888888888888";
const RUN = "20000000-0000-4000-8000-000000000009";

const task = (progress: Array<{ label: string; at: string }>, state = "running") => ({
  id: TASK, agentId: PRINCE, objective: "Research validators", input: {}, state, deadline: null, startedAt: AT,
  limits: { taskUsdc: "0", taskUsageUnits: "0", maxToolCalls: 8, maxPaidPurchases: 1, maxPlanningCalls: 2 },
  used: { toolCalls: 0, paidPurchases: 0, planningCalls: 0 }, createdAt: AT, updatedAt: AT, progress,
});
const job = (state: string, result: Record<string, unknown> | null = null) => ({ id: "job-1", agentId: PRINCE, taskId: TASK, kind: "custom", state, result, scheduledAt: AT, createdAt: AT, updatedAt: AT, attempts: 1 });

describe("live agent progress", () => {
  it("lists reported steps with earlier ones ticked, the current one marked, and elapsed time", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(Date.parse(AT) + 65_000);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let steps = [{ label: "Planning the task", at: AT }];
    const rec = recordingFetch((url) => {
      if (url.includes("/tasks?")) return { tasks: [task(steps)], jobs: [job("leased")] };
      if (url.includes("/balances")) return balancesAfterTopUpAndConsumption();
      if (url.includes("/activity")) return { events: [], purchases: [] };
      return { items: [] };
    });
    vi.stubGlobal("fetch", rec.impl);
    await act(async () => { render(withRole(<AgentDetail agentId={PRINCE} />)); });
    expect(screen.getByText("Prince is working…")).toBeTruthy();
    expect(screen.getByText("1m 05s")).toBeTruthy();
    expect(screen.getByText("Planning the task").closest("li")!.getAttribute("aria-current")).toBe("step");

    steps = [...steps, { label: "Reading page docs.solana.com", at: AT }];
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText("Planning the task").closest("li")!.className).toBe("is-done");
    expect(screen.getByText("Reading page docs.solana.com").closest("li")!.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("1m 08s")).toBeTruthy();
  });

  it("shows a proposed run's live status from the run view, linked to the run page", async () => {
    const content = ["I'd like to run 'Carousel'.", "", "— Details —", `Workflow run: ${RUN} (approved by your assignment).`].join("\n");
    const rec = recordingFetch((url) => {
      if (url.includes("/tasks?")) return { tasks: [task([], "completed")], jobs: [job("completed", { workflowRun: { runId: RUN, status: "approved", title: "Carousel" } })] };
      if (url.includes("/balances")) return balancesAfterTopUpAndConsumption();
      if (url.includes("/activity")) return { events: [], purchases: [] };
      if (url.includes(`/workflows/runs/${RUN}`)) return { run: { id: RUN, status: "running", steps: [{ execution: "delivered" }, { execution: "pending" }, { execution: "not_run" }], waiting: null } };
      if (url.includes("/content?")) return { items: [draft({ kind: "research_brief", title: "Validators", content, taskId: TASK, agent: { id: PRINCE, name: "Scout", role: "custom" } })] };
      return { items: [] };
    });
    vi.stubGlobal("fetch", rec.impl);
    await act(async () => { render(withRole(<AgentDetail agentId={PRINCE} />)); });
    expect(screen.getByText(/Workflow run: Running step 2 of 3/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View run" }).getAttribute("href")).toBe(`/marketplace/runs/${RUN}`);
  });

  it("words each run state plainly", () => {
    const steps = [{ execution: "delivered" }, { execution: "delivered" }];
    expect(runStatusLine({ status: "awaiting_approval", steps })).toBe("Waiting for your approval");
    expect(runStatusLine({ status: "running", steps: [{ execution: "pending" }] })).toBe("Running step 1 of 1");
    expect(runStatusLine({ status: "running", steps, waiting: { reason: "funding" } })).toBe("Running step 2 of 2 (waiting: funding)");
    expect(runStatusLine({ status: "completed", steps })).toBe("Done");
    expect(runStatusLine({ status: "failed", steps })).toBe("Failed");
  });
});
