import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeResult } from "../lib/results";
import { ApiError, api } from "../lib/api";
import type { Job, Task } from "../lib/types";

afterEach(() => vi.unstubAllGlobals());

const job = (result: Record<string, unknown>, taskId: string | null = "t1"): Job => ({
  id: "j1",
  agentId: "a1",
  taskId,
  kind: "research",
  state: "completed",
  scheduledAt: "",
  attempts: 1,
  result,
  createdAt: "",
  updatedAt: "",
});

describe("backend truth in summaries and errors", () => {
  it("reports the task state, not the job lease outcome, and lists unpurchased services", () => {
    const task = { id: "t1", state: "incomplete" } as Task;
    const s = summarizeResult(job({ artifactId: "x", paid: [{ sku: "research-basic", outcome: "not purchased (SERVICE_NOT_ALLOWED)" }] }), task);
    expect(s).toBe("Stopped part-way · Research data: not purchased (SERVICE_NOT_ALLOWED) · Saved to Outputs");
    expect(s).not.toContain("completed");
    expect(summarizeResult(job({ decision: "paused_after_rejection", detail: "waiting" }, null))).toBe("paused_after_rejection: waiting");
    expect(summarizeResult(undefined)).toBe("No result yet");
  });

  it("maps a service without its JSON API to NOT_READY and keeps JSON error codes", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>Cannot GET</html>", { status: 404, headers: { "content-type": "text/html" } }));
    await expect(api("wallet", "/notes/status")).rejects.toMatchObject({ code: "NOT_READY", status: 404 });
    vi.stubGlobal("fetch", async () => Response.json({ error: { code: "BUDGET_EXCEEDED", message: "agent cap" } }, { status: 409 }));
    const e = await api("control", "/agents").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ code: "BUDGET_EXCEEDED", message: "agent cap" });
  });
});
