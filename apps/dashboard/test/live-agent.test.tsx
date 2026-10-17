// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDetail, ResearchForm } from "../components/AgentDetail";
import { usePolling } from "../components/hooks";
import { withRole } from "./access-fixtures";
import { agent, balancesAfterTopUpAndConsumption, draft, PRINCE, purchase, recordingFetch } from "./fixtures";

vi.mock("next/navigation", () => ({ usePathname: () => `/agents/${PRINCE}`, useParams: () => ({}) }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("live agent tasks", () => {
  it("updates finished work, saved content and payments without navigation, then stops on unmount", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let finished = false;
    const at = "2026-10-15T00:00:00.000Z";
    const rec = recordingFetch((url) => {
      if (url.includes("/tasks?")) return { tasks: [], jobs: [{ id: "job-1", agentId: PRINCE, taskId: null, kind: "research", state: finished ? "completed" : "queued", result: finished ? { decision: "Done", detail: "Research is ready" } : null, scheduledAt: at, createdAt: at, updatedAt: at, attempts: 1 }] };
      if (url.includes("/balances")) return balancesAfterTopUpAndConsumption();
      if (url.includes("/activity")) return { events: [], purchases: finished ? [purchase({ agentId: PRINCE })] : [] };
      if (url.includes("/content?")) return { items: finished ? [draft({ title: "Fresh research brief", agent: { id: PRINCE, name: "Prince", role: "research" } })] : [] };
      return { items: [] };
    });
    vi.stubGlobal("fetch", rec.impl);
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(withRole(<AgentDetail agentId={PRINCE} />)); });
    expect(screen.queryByText("Done: Research is ready")).toBeNull();
    finished = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText("Done: Research is ready")).toBeTruthy();
    expect(screen.getByText("Fresh research brief")).toBeTruthy();
    expect(screen.getByRole("button", { name: /inference-credit-pack/ })).toBeTruthy();
    for (const path of ["/tasks?", "/balances", "/activity", "/content?", "/handoffs"]) {
      expect(rec.calls.filter((call) => call.url.includes(path))).toHaveLength(2);
    }
    const completedCount = rec.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(rec.calls).toHaveLength(completedCount);
    view.unmount();
    const count = rec.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(rec.calls).toHaveLength(count);
  });

  it("does not overlap slow refreshes or continue after unmount", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const view = renderHook(() => usePolling(refresh, "agent"));
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(refresh).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { finish(); await vi.advanceTimersByTimeAsync(6000); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("research task budget", () => {
  it.each([".01", "$0.01", "0.0000001", "-1", "oops"])("rejects invalid nonblank budget %s before queueing", async (budget) => {
    const rec = recordingFetch();
    vi.stubGlobal("fetch", rec.impl);
    const onQueued = vi.fn();
    render(withRole(<ResearchForm agent={agent(PRINCE, "Prince", "research")} disabled={false} onQueued={onQueued} />));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Find sources" } });
    fireEvent.change(screen.getByLabelText("Task budget (USDC, optional)"), { target: { value: budget } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start research task" })); });
    expect(screen.getByRole("alert").textContent).toContain("Enter a task budget such as 0.01");
    expect(rec.calls).toHaveLength(0);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it.each([["", undefined], ["   ", undefined], ["0.01", "10000"]])("queues budget %s with the intended limit", async (budget, expected) => {
    const rec = recordingFetch(() => ({ taskId: "task-1", executor: "queued" }));
    vi.stubGlobal("fetch", rec.impl);
    render(withRole(<ResearchForm agent={agent(PRINCE, "Prince", "research")} disabled={false} onQueued={vi.fn()} />));
    fireEvent.change(screen.getByLabelText("Research question"), { target: { value: "Find sources" } });
    fireEvent.change(screen.getByLabelText("Task budget (USDC, optional)"), { target: { value: budget } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start research task" })); });
    expect(rec.calls).toHaveLength(1);
    expect((rec.calls[0]!.body as Record<string, unknown>).taskLimitTestUsdc).toBe(expected);
  });
});
