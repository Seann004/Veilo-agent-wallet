import { describe, expect, it } from "vitest";
import type { MarketplaceClient } from "../src/marketplace/client";
import { MarketplaceWorkflowPort } from "../src/workflows/adapters";

const replying = (status: number, body: unknown) => ({ signed: async () => ({ status, body }) }) as unknown as MarketplaceClient;

describe("marketplace workflow port", () => {
  it("reports a marketplace that refuses this controller as an unlinked controller, never as an expired owner session", async () => {
    for (const status of [401, 403]) {
      const port = new MarketplaceWorkflowPort(replying(status, { error: { code: "UNAUTHENTICATED", message: "unknown controller" } }));
      await expect(port.version("v1")).rejects.toMatchObject({ code: "NOT_READY", message: expect.stringMatching(/not linked to your marketplace account/) });
    }
  });

  it("keeps the marketplace's own code for other refusals", async () => {
    const port = new MarketplaceWorkflowPort(replying(404, { error: { code: "NOT_FOUND", message: "no such version" } }));
    await expect(port.version("v1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
