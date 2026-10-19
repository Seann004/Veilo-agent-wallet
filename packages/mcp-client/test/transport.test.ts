import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient, McpError, requestBounded } from "../src/index";

let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });

async function local(handler: Parameters<typeof createServer>[1]): Promise<URL> {
  server = createServer(handler).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
}

describe("shared bounded transport", () => {
  it("applies the cap to decoded bytes, including compressed replies", async () => {
    const url = await local((_req, res) => { res.setHeader("content-encoding", "gzip"); res.end(gzipSync(Buffer.alloc(2000, 97))); });
    await expect(requestBounded(url, { allowAddress: () => true, maxBytes: 1000 })).rejects.toThrow(/size bound/);
    const allowed = await requestBounded(url, { allowAddress: () => true, maxBytes: 2000 });
    expect(allowed.body).toHaveLength(2000);
    expect(allowed.headers["content-encoding"]).toBeUndefined();
  });

  it("preserves an explicit provider failure from the bounded transport", async () => {
    const client = new McpClient("https://data.example/mcp", { fetch: async () => { throw new McpError("PROVIDER_FAILED", "response exceeds the size bound"); } });
    await expect(client.initialize()).rejects.toMatchObject({ code: "PROVIDER_FAILED" });
  });
});
