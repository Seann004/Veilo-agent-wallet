import { afterEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { publicUrl } from "../src/browser";
import { safeFetch } from "../src/safe-fetch";
import { publicFetch } from "@veilo/mcp-client";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
afterEach(() => vi.clearAllMocks());

describe("connection-bound DNS", () => {
  it("rejects rebinding after a public preflight instead of trusting its result", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never).mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never);
    const url = "http://rebind.example/";
    expect(await publicUrl(new URL(url))).toBe(true);
    await expect(safeFetch(url, { approvedOrigins: ["http://rebind.example"], localServiceOrigins: [] })).rejects.toThrow(/private/);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("uses the same connection rule for public MCP requests", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as never);
    await expect(publicFetch("https://rebind.example/mcp")).rejects.toThrow(/non-public/);
    expect(lookup).toHaveBeenCalledOnce();
  });
});
