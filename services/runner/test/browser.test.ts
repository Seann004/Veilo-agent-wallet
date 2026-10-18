import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChromeReader, pinnedFetch, publicUrl } from "../src/browser";

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
    if (req.url === "/big") {
      // No content-length: the cap has to hold while streaming.
      const chunk = Buffer.alloc(1024 * 1024, 97);
      for (let i = 0; i < 6; i += 1) res.write(chunk);
      return res.end();
    }
    if (req.url === "/gzip-bomb") {
      res.writeHead(200, { "content-encoding": "gzip" });
      return res.end(gzipSync(Buffer.alloc(6 * 1024 * 1024, 97)));
    }
    if (req.url === "/gzip") {
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/html" });
      return res.end(gzipSync("<html><title>z</title><body>zipped text</body></html>"));
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

describe("pinned fetch", () => {
  it("checks the connected address, so a name resolving to loopback is refused at connect time", async () => {
    const port = new URL(base).port;
    await expect(pinnedFetch(new URL(`http://localhost:${port}/`), "GET", {})).rejects.toThrow("non-public address");
    await expect(pinnedFetch(new URL(`${base}/`), "GET", {})).rejects.toThrow("non-public address");
  });

  it("bounds the decoded body while streaming and decodes gzip", async () => {
    const any = () => true;
    await expect(pinnedFetch(new URL(`${base}/big`), "GET", {}, any)).rejects.toThrow("too large");
    await expect(pinnedFetch(new URL(`${base}/gzip-bomb`), "GET", {}, any)).rejects.toThrow("too large");
    const ok = await pinnedFetch(new URL(`${base}/gzip`), "GET", {}, any);
    expect(ok.body.toString()).toContain("zipped text");
    expect(ok.headers["content-encoding"]).toBeUndefined();
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
