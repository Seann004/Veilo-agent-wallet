import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FetchDenied, isPrivateAddress, safeFetch } from "../src/safe-fetch";

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function local(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server!.once("listening", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("tool HTTP restrictions", () => {
  it("classifies private, loopback, link-local, CGNAT and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    }
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });

  it("rejects unapproved origins, credentials, other schemes and private resolution", async () => {
    const policy = { approvedOrigins: ["https://data.example"], localServiceOrigins: [] };
    await expect(safeFetch("https://other.example/x", policy)).rejects.toBeInstanceOf(FetchDenied);
    await expect(safeFetch("file:///etc/passwd", policy)).rejects.toThrow(/http/);
    await expect(safeFetch("https://u:p@data.example/", policy)).rejects.toThrow(/credentials/);
    await expect(safeFetch("https://data.example/x", policy, async () => ["10.0.0.5"])).rejects.toThrow(/private/);
    await expect(safeFetch("https://data.example/x", policy, async () => ["93.184.216.34", "127.0.0.1"])).rejects.toThrow(/private/);
  });

  it("allows an explicitly configured local demo service and refuses its redirects", async () => {
    const origin = await local((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/" });
        res.end();
        return;
      }
      res.end("ok");
    });
    await expect(safeFetch(`${origin}/x`, { approvedOrigins: [origin], localServiceOrigins: [] })).rejects.toThrow(/private/);
    const ok = await safeFetch(`${origin}/x`, { approvedOrigins: [origin], localServiceOrigins: [origin] });
    expect(ok).toEqual({ status: 200, text: "ok" });
    await expect(safeFetch(`${origin}/redirect`, { approvedOrigins: [origin], localServiceOrigins: [origin] })).rejects.toThrow(/redirect/);
  });
});
