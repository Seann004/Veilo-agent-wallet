import { describe, expect, it } from "vitest";
import { ControlClient } from "../src/control-client";
import { planningSummary } from "../src/roles/common";

const bounds = { maxToolCalls: 8, maxPaidPurchases: 2, maxPlanningCalls: 4, deadlineMs: Date.now() + 60_000 };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const byok = { label: "Your model provider (bring your own key)", callIndex: 1, gateway: { outcome: { status: "succeeded", text: "{}", model: "glm-5.3-flash", mode: "byok" } } };
const sponsored = { label: "operator-sponsored planning", gateway: { outcome: { status: "succeeded", text: "{}" } } };

function clientWith(bodies: unknown[]): ControlClient {
  let i = 0;
  return new ControlClient({ baseUrl: "http://control.test", token: "t", fetch: async () => reply(bodies[i++]) });
}

describe("planning summary", () => {
  it("names the owner's model when planning ran on it", async () => {
    const c = clientWith([byok]);
    await c.planning("task", "plan", [{ role: "user", content: "x" }], bounds);
    expect(planningSummary(c)).toBe("1 planning call on your model (glm-5.3-flash)");
  });

  it("labels operator-sponsored planning", async () => {
    const c = clientWith([sponsored, sponsored]);
    await c.planning("task", "a", [{ role: "user", content: "x" }], bounds);
    await c.planning("task", "b", [{ role: "user", content: "x" }], bounds);
    expect(planningSummary(c)).toBe("2 operator-sponsored planning calls");
  });

  it("shows both counts when mixed, and zero sponsored when nothing ran", async () => {
    const c = clientWith([byok, sponsored]);
    expect(planningSummary(c)).toBe("0 operator-sponsored planning calls");
    await c.planning("task", "a", [{ role: "user", content: "x" }], bounds);
    await c.planning("task", "b", [{ role: "user", content: "x" }], bounds);
    expect(planningSummary(c)).toBe("1 planning call on your model (glm-5.3-flash) and 1 operator-sponsored planning call");
  });
});
