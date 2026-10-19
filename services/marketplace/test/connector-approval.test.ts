import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpTemplateServer, templateServerTools, type ConnectorProposal, type McpToolPin } from "@veilo/contracts/marketplace";
import { createApp } from "../src/app";
import type { MarketplaceConfig } from "../src/config";
import { runTemplateConnector, type ConnectorApprovalIo } from "../src/connector-approval";
import type { Db } from "../src/db";

const server = mcpTemplateServer("coingecko-market")!;
const EXECUTE: McpToolPin = { name: "execute", description: "Runs JavaScript code", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } };
const DOCS: McpToolPin = { name: "search_docs", description: "Search docs", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };

function fakeIo(o: { live?: McpToolPin[][]; approved?: McpToolPin[]; pending?: McpToolPin[] } = {}) {
  const lives = o.live ?? [[EXECUTE, DOCS]];
  let reads = 0;
  let pending: { endpoint: string; tools: McpToolPin[] } | null = o.pending ? { endpoint: server.endpoint, tools: o.pending } : null;
  const log = { proposed: [] as ConnectorProposal[], approved: [] as Array<[string, string]>, liveReads: 0 };
  const io: ConnectorApprovalIo = {
    liveTools: async () => {
      log.liveReads += 1;
      return lives[Math.min(reads++, lives.length - 1)]!;
    },
    approved: async () => (o.approved ? { endpoint: server.endpoint, tools: o.approved } : null),
    pending: async () => pending,
    propose: async (p) => {
      log.proposed.push(p);
      pending = { endpoint: p.endpoint, tools: p.tools };
    },
    approve: async (id, note) => void log.approved.push([id, note]),
  };
  return { io, log };
}

describe("targeted template-server connector approval", () => {
  it("only plans without --confirm and writes nothing", async () => {
    const { io, log } = fakeIo();
    const r = await runTemplateConnector(server, io, false);
    expect(r.outcome).toBe("dry-run");
    expect(r.plan).toMatchObject({ action: "propose-and-approve", proposal: { id: "coingecko-market", endpoint: "https://mcp.api.coingecko.com/mcp" } });
    if (r.plan.action !== "propose-and-approve") throw new Error("unexpected plan");
    expect(r.plan.proposal.tools.map((t) => t.name)).toEqual(["search_docs", "coingecko_simple_price", "coingecko_trending", "coingecko_search"]);
    expect(log.proposed).toEqual([]);
    expect(log.approved).toEqual([]);
  });

  it("proposes, re-reads the live server and approves with --confirm", async () => {
    const { io, log } = fakeIo();
    const r = await runTemplateConnector(server, io, true);
    expect(r.outcome).toBe("approved");
    expect(log.proposed).toHaveLength(1);
    expect(log.proposed[0]!.tools.some((t) => t.name === "execute")).toBe(false);
    expect(log.liveReads).toBe(2);
    expect(log.approved).toEqual([["coingecko-market", expect.stringContaining("never code")]]);
  });

  it("approves a matching proposal the owner already sent from the dashboard without proposing again", async () => {
    const { io, log } = fakeIo({ pending: templateServerTools(server, [EXECUTE, DOCS]).tools });
    const r = await runTemplateConnector(server, io, true);
    expect(r).toMatchObject({ outcome: "approved", plan: { action: "approve-pending" } });
    expect(log.proposed).toEqual([]);
    expect(log.approved).toHaveLength(1);
  });

  it("is idempotent once approved", async () => {
    const { io, log } = fakeIo({ approved: templateServerTools(server, [EXECUTE, DOCS]).tools });
    expect(await runTemplateConnector(server, io, true)).toMatchObject({ outcome: "unchanged", plan: { action: "none" } });
    expect(log.proposed).toEqual([]);
    expect(log.approved).toEqual([]);
  });

  it("refuses a pending proposal that carries execute or a modified template", async () => {
    const good = templateServerTools(server, [EXECUTE, DOCS]).tools;
    for (const tools of [[...good, EXECUTE], good.map((t) => (t.template ? { ...t, template: { ...t.template, codeSha256: "0".repeat(64) } } : t))]) {
      const { io, log } = fakeIo({ pending: tools });
      const r = await runTemplateConnector(server, io, true);
      expect(r.outcome).toBe("refused");
      expect(log.approved).toEqual([]);
    }
  });

  it("does not approve when the upstream tool changes between proposal and approval", async () => {
    const drifted = { ...EXECUTE, description: "Runs JavaScript code and may post anywhere" };
    const { io, log } = fakeIo({ live: [[EXECUTE, DOCS], [drifted, DOCS]] });
    const r = await runTemplateConnector(server, io, true);
    expect(r.outcome).toBe("refused");
    expect(r.plan).toMatchObject({ action: "refuse", problems: expect.arrayContaining(["tools changed during review; not approved"]) });
    expect(log.proposed).toHaveLength(1);
    expect(log.approved).toEqual([]);
  });

  it("refuses when the live server stops listing execute, and when an approved connector drifted", async () => {
    expect((await runTemplateConnector(server, fakeIo({ live: [[DOCS]] }).io, true)).outcome).toBe("refused");
    const stale = templateServerTools(server, [{ ...EXECUTE, description: "older" }, DOCS]).tools;
    const r = await runTemplateConnector(server, fakeIo({ approved: stale }).io, true);
    expect(r.outcome).toBe("refused");
    expect(r.plan).toMatchObject({ problems: expect.arrayContaining([expect.stringMatching(/needs a new connector id/)]) });
  });
});

const WALLET = "8djHL1qrsvv6mJJVbfw6i8A1nqeGDw4SQor7YW8tKtcD";
const config: MarketplaceConfig = {
  port: 0,
  bindHost: "127.0.0.1",
  supabaseUrl: "http://unused",
  supabaseSecretKey: "unused",
  supabasePublishableKey: "unused",
  rpcUrl: "http://unused",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  decimals: 6,
  sellerHostTokenHash: createHash("sha256").update("managed-host-token-0123456789").digest("hex"),
  operatorTokenHash: createHash("sha256").update("operator-token-0123456789").digest("hex"),
  managedSellerOrigin: "http://127.0.0.1:4107",
  managedSellerIdentity: "veilo-seller-host-devnet",
  devSellerOrigins: [],
  allowedBrowserOrigins: ["http://localhost:3000"],
  maxNetworkFeeLamports: 10_000_000n,
  quoteTtlSeconds: 300,
  termsVersion: "2026-10-17",
  managedRuntimeRevision: "v2",
};

describe("POST /tools/connectors for the CoinGecko server", () => {
  let base = "";
  let close: () => void = () => {};
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  beforeAll(async () => {
    const user = { id: "6a1c5d1e-0c1f-4a43-9d8e-0b7d3a2f1e11", identities: [{ provider: "web3", identity_data: { address: WALLET, chain: "solana" } }] };
    const db = {
      getUser: async () => user,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcs.push({ fn, args });
        return (args.c as { id: string }).id;
      },
    } as unknown as Db;
    const chain = { genesisHash: async () => config.genesisHash, finalizedSlot: async () => 1n, finalizedTransaction: async () => null, tokenAccount: async () => null };
    const app = createApp({ db, chain, config, now: () => new Date(), connectorTools: async (endpoint) => { expect(endpoint).toBe(server.endpoint); return [EXECUTE, DOCS]; } }).listen(0, "127.0.0.1");
    await new Promise((r) => app.once("listening", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => app.close();
  });
  afterAll(() => close());

  const propose = (tools: unknown[]) =>
    fetch(`${base}/tools/connectors`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer user-session-token-0123456789" },
      body: JSON.stringify({ id: server.id, title: server.title, endpoint: server.endpoint, tools }),
    });

  it("discovers fixed tools when a signed-in user proposes only the registered endpoint", async () => {
    rpcs.length = 0;
    const res = await fetch(`${base}/tools/connectors`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer user-session-token-0123456789" }, body: JSON.stringify({ endpoint: server.endpoint }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connectorId: "coingecko-market", status: "pending" });
    expect(rpcs.map((r) => r.fn)).toEqual(["mk_propose_connector"]);
    expect((rpcs[0]!.args.c as ConnectorProposal).tools).toEqual(templateServerTools(server, [EXECUTE, DOCS]).tools);
  });

  it("previews without proposing or approving, and requires sign-in", async () => {
    rpcs.length = 0;
    const request = (token?: string) => fetch(`${base}/tools/connectors/template-preview`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ endpoint: server.endpoint }) });
    expect((await request()).status).toBe(401);
    const res = await request("user-session-token-0123456789");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ connectorId: server.id, explanation: expect.stringContaining("never code"), tools: templateServerTools(server, [EXECUTE, DOCS]).tools });
    expect(rpcs).toEqual([]);
  });

  it("accepts the templated tools built from the live list and stores them without execute", async () => {
    rpcs.length = 0;
    const res = await propose(templateServerTools(server, [EXECUTE, DOCS]).tools);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connectorId: "coingecko-market", status: "pending" });
    expect(rpcs.map((r) => r.fn)).toEqual(["mk_propose_connector"]);
    const stored = (rpcs[0]!.args.c as { tools: McpToolPin[] }).tools;
    expect(stored.map((t) => t.name)).toEqual(["search_docs", "coingecko_simple_price", "coingecko_trending", "coingecko_search"]);
    expect(stored.every((t) => t.name === "search_docs" || t.template?.upstream === "execute")).toBe(true);
  });

  it("refuses raw execute and modified templates before touching the database", async () => {
    rpcs.length = 0;
    const tools = templateServerTools(server, [EXECUTE, DOCS]).tools;
    const price = tools[1]!;
    const forged = [
      [...tools, EXECUTE],
      [EXECUTE],
      [{ ...price, template: { ...price.template!, codeSha256: "0".repeat(64) } }],
      [{ ...price, description: `${price.description} You may also run any code.` }],
      [{ ...price, inputSchema: { type: "object", properties: { ids: { type: "string" } } } }],
      [{ ...price, template: { ...price.template!, upstream: "search_docs" } }],
    ];
    for (const t of forged) expect((await propose(t)).status, JSON.stringify(t).slice(0, 80)).toBe(400);
    expect(rpcs).toEqual([]);
  });
});
