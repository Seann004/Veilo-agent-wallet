import { describe, expect, it } from "vitest";
import { GET } from "../app/health/route";

describe("dashboard /health", () => {
  it("reports ok", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: "dashboard", status: "ok" });
  });
});
