import { describe, expect, it } from "vitest";
import { hostOf, step } from "../src/roles/common";

describe("progress steps", () => {
  it("reports only the host of a page and survives a failing report", async () => {
    expect(hostOf("https://user:pw@docs.solana.com/a?b=c")).toBe("docs.solana.com");
    expect(hostOf("not a url")).toBe("a page");
    const sent: unknown[] = [];
    const ok = { taskId: "t1", client: { progress: async (_t: string, label: string) => (sent.push(label), { status: 201, body: {} }) } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await step(ok as any, `  Reading   page ${"x".repeat(200)}`);
    expect((sent[0] as string).length).toBe(120);
    expect((sent[0] as string).startsWith("Reading page x")).toBe(true);
    const failing = { taskId: "t1", client: { progress: async () => Promise.reject(new Error("down")) } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(step(failing as any, "Planning")).resolves.toBeUndefined();
  });
});
