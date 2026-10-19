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
    expect(s).toBe("Stopped part-way · Research data: not purchased (not allowed by its limits) · Saved to Outputs");
    expect(s).not.toContain("completed");
    expect(summarizeResult(job({ decision: "paused_after_rejection", detail: "waiting" }, null))).toBe("paused_after_rejection: waiting");
    expect(summarizeResult(undefined)).toBe("No result yet");
  });

  it("says why a job failed instead of a bare state", () => {
    const failed = { id: "t1", state: "failed" } as Task;
    expect(summarizeResult(job({ failure: "Couldn't save the answer: it cited a page the agent wasn't cleared to read.", artifactId: null }), failed)).toBe(
      "Failed · Couldn't save the answer: it cited a page the agent wasn't cleared to read.",
    );
    expect(summarizeResult(job({ artifactId: null, notes: [] }), failed)).toBe("Failed · No reason recorded");
    // An older record: the agent produced an answer, but no output was saved.
    expect(summarizeResult(job({ didWork: true, artifactId: null, notes: [] }), failed)).toBe("Failed · The answer wasn't saved");
    // A runner reason as a control error object, not a string.
    expect(summarizeResult(job({ failure: "Couldn't finish (POLICY_DENIED: artifact refused).", error: { code: "POLICY_DENIED" } }), failed)).toBe(
      "Failed · Couldn't finish (POLICY_DENIED: artifact refused).",
    );
    expect(summarizeResult({ ...job({ reconciled: true, reason: "lease expired", purchases: [] }), state: "failed" }, undefined)).toBe(
      "Failed · The runner stopped responding before it finished",
    );
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

describe("settled payments", () => {
  it("treats only finished outcomes as settled, including prepaid, rejected and recovered ones", async () => {
    const { isSettled } = await import("../lib/labels");
    const base = { authorization: "released", merchant: "finalized", fulfilment: "delivered", recovery: "none" };
    expect(isSettled(base)).toBe(true);
    expect(isSettled({ ...base, merchant: "not_required" })).toBe(true);
    expect(isSettled({ ...base, merchant: "not_required", fulfilment: "abandoned" })).toBe(true);
    expect(isSettled({ ...base, authorization: "rejected", merchant: "not_started", fulfilment: "not_started" })).toBe(true);
    expect(isSettled({ ...base, recovery: "recovered" })).toBe(true);
    expect(isSettled({ ...base, merchant: "submitted", fulfilment: "not_started" })).toBe(false);
    expect(isSettled({ ...base, fulfilment: "paid_without_result" })).toBe(false);
    expect(isSettled({ ...base, recovery: "recoverable" })).toBe(false);
    expect(isSettled({ ...base, authorization: "awaiting_approval" })).toBe(false);
  });
});
