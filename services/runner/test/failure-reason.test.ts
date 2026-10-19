import { describe, expect, it } from "vitest";
import { withFailureReason } from "../src/roles/common";
import { runOnce } from "../src/worker";

describe("failed jobs always record a reason", () => {
  it("keeps an existing reason and derives one from an error, a note or nothing", () => {
    const kept = { taskState: "failed" as const, summary: { failure: "Couldn't save the answer (HTTP 500).", error: "x" } };
    expect(withFailureReason(kept)).toBe(kept);
    expect(withFailureReason({ taskState: "failed", summary: { error: "TypeError: boom" } }).summary.failure).toBe("TypeError: boom");
    expect(withFailureReason({ taskState: "failed", summary: { error: { code: "POLICY_DENIED", message: "artifact refused" } } }).summary.failure).toBe(
      "Couldn't finish (POLICY_DENIED: artifact refused).",
    );
    expect(withFailureReason({ taskState: "failed", summary: { error: null, notes: ["first", "No model provider is set."] } }).summary.failure).toBe("No model provider is set.");
    expect(withFailureReason({ taskState: "failed", summary: { notes: [] } }).summary.failure).toBe("The agent stopped without giving a reason.");
    const done = { taskState: "completed" as const, summary: { notes: [] } };
    expect(withFailureReason(done)).toBe(done);
  });

  it("stores the reason with the completed job when a role fails without one", async () => {
    const taskId = "11111111-1111-4111-8111-111111111111";
    const completed: Array<Record<string, unknown>> = [];
    // A content task whose catalog has no content package and whose model provider is not set.
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const path = new URL(url).pathname;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (path === "/worker/jobs/claim") {
        return Response.json({
          job: { id: "22222222-2222-4222-8222-222222222222", version: "1" },
          task: { id: taskId, input: { topic: "t", audience: "a", channels: ["x"], voice: "v" }, limits: {} },
        });
      }
      if (path.endsWith("/complete")) {
        completed.push(body);
        return Response.json({ ok: true });
      }
      if (path === "/worker/catalog") return Response.json({ items: [] });
      if (path === "/worker/ai") return Response.json({ error: { code: "NOT_READY", message: "no provider" } }, { status: 409 });
      return Response.json({});
    };
    const done = await runOnce(
      { agentId: "33333333-3333-4333-8333-333333333333", role: "content", token: "t" },
      { controlUrl: "http://control.test", workerId: "w", fetch: fakeFetch, fetchPolicy: { approvedOrigins: [], localServiceOrigins: [] } },
    );
    expect(done?.outcome.taskState).toBe("failed");
    expect(completed).toHaveLength(1);
    const result = completed[0]!.result as Record<string, unknown>;
    expect(completed[0]!.outcome).toBe("failed");
    expect(typeof result.failure).toBe("string");
    expect(String(result.failure)).toMatch(/content-package/);
  });
});
