import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChromeReader, publicUrl } from "../src/browser";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let server: Server;
let base = "";
let hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/to-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    }
    if (req.url === "/to-ok") {
      res.writeHead(302, { location: "/hop2" });
      return res.end();
    }
    if (req.url === "/hop2") {
      res.writeHead(302, { location: "/ok" });
      return res.end();
    }
    if (req.url === "/hop-to-metadata") {
      res.writeHead(302, { location: "/to-metadata" });
      return res.end();
    }
    if (req.url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      return res.end();
    }
    if (req.url === "/ws-page") {
      return res.end(`<html><title>ws</title><body>page<script>
        const ws = new WebSocket("ws://127.0.0.1:1/x"); ws.onopen = () => { document.body.innerText = "socket opened"; };
      </script></body></html>`);
    }
    return res.end("<html><title>ok</title><body>public page text</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("public URL rule", () => {
  it("refuses private, local, credentialed and custom-port URLs", async () => {
    for (const bad of ["http://127.0.0.1/", "http://169.254.169.254/", "http://[::ffff:10.0.0.1]/", "http://printer.local/", "https://user:pw@solana.com/", "https://solana.com:8443/", "ftp://solana.com/"]) {
      expect(await publicUrl(new URL(bad)), bad).toBe(false);
    }
    expect(await publicUrl(new URL("https://1.1.1.1/"))).toBe(true);
  });
});

describe.skipIf(!existsSync(CHROME))("read-only browser (installed Chrome)", () => {
  it("refuses to load a loopback page under the real rule", async () => {
    const reader = new ChromeReader({ executablePath: CHROME });
    try {
      await expect(reader.read(`${base}/`)).rejects.toThrow();
    } finally {
      await reader.close();
    }
  }, 30_000);

  // The test server stands in for a public site; everything else keeps the real rule.
  const onlyTestServer = (u: URL) => Promise.resolve(u.origin === base);

  it("checks every redirect hop: no chain can reach a private address, and loops stop", async () => {
    const reader = new ChromeReader({ executablePath: CHROME, allowUrl: onlyTestServer });
    try {
      await expect(reader.read(`${base}/to-metadata`)).rejects.toThrow();
      await expect(reader.read(`${base}/hop-to-metadata`)).rejects.toThrow();
      await expect(reader.read(`${base}/loop`)).rejects.toThrow();
      const ok = await reader.read(`${base}/to-ok`);
      expect(ok.text).toContain("public page text");
    } finally {
      await reader.close();
    }
  }, 30_000);

  it("closes WebSockets the page opens", async () => {
    hits = [];
    const reader = new ChromeReader({ executablePath: CHROME, allowUrl: onlyTestServer });
    try {
      const r = await reader.read(`${base}/ws-page`);
      expect(r.text).not.toContain("socket opened");
    } finally {
      await reader.close();
    }
  }, 30_000);
});
