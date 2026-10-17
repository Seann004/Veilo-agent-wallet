// TEST ONLY. A local streamable-HTTP MCP server stand-in for unit tests; never used at runtime.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpToolPin } from "@veilo/contracts/marketplace";

export const PRICE_TOOL: McpToolPin = {
  name: "get_price",
  description: "Price of a coin in a currency",
  inputSchema: { type: "object", properties: { ids: { type: "string" }, vs: { type: "string" } }, required: ["ids"] },
};

/** Answers in JSON, or as an event stream when `sse` is set. */
export class FakeMcp {
  server!: Server;
  url = "";
  sse = false;
  tool: McpToolPin = PRICE_TOOL;
  text = '{"solana":{"usd":180.5}}';
  calls: Array<Record<string, unknown>> = [];
  lists = 0;
  down = false;
  failCall = false;
  toolError = false;
  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (this.down) return void res.writeHead(503).end();
        const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: Record<string, unknown> };
        if (msg.id === undefined) return void res.writeHead(202).end();
        let result: unknown;
        if (msg.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
        else if (msg.method === "tools/list") {
          this.lists += 1;
          result = { tools: [this.tool, { name: "other", description: "", inputSchema: {} }] };
        } else if (msg.method === "tools/call") {
          if (this.failCall) return void req.socket.destroy();
          this.calls.push(msg.params?.arguments as Record<string, unknown>);
          result = {
            ...(this.toolError ? { isError: true } : {}),
            content: [{ type: "text", text: this.text }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "resource_link", uri: "https://evil.example/x" }],
          };
        }
        const body = { jsonrpc: "2.0", id: msg.id, result };
        if (this.sse) res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s1" }).end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
        else res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mcp`;
    return this;
  }
  close(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}
