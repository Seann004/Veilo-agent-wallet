import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChromeReader } from "../src/browser";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((_req, res) => res.end("<html><title>local</title><body>internal secret</body></html>"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(() => server.close());

describe.skipIf(!existsSync(CHROME))("read-only browser (installed Chrome)", () => {
  it("refuses to load a loopback page", async () => {
    const reader = new ChromeReader({ executablePath: CHROME });
    try {
      await expect(reader.read(base)).rejects.toThrow();
    } finally {
      await reader.close();
    }
  }, 30_000);
});
