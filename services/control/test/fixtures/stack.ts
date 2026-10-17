// TEST ONLY. Boots control (real ledger, routes, orchestrator, scheduler) against the real
// gateway service code with its test chain/facilitator and FIXTURE provider.
import type { ChannelService } from "../../src/channels/service";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  DEMO_TOKEN_MINT,
  DEVNET_CAIP2,
  DEVNET_GENESIS_HASH,
  createServiceHealth,
  loadConfig,
  type AgentPolicyInput,
  type FundingProvider,
  type WorkspacePolicyInput,
} from "@veilo/contracts";
import { FixtureProvider, makeHarness, VALID_CONTENT, type Harness } from "../../../gateway/test/harness";
import type { ChatRequest, ChatResult } from "../../../gateway/src/provider/types";
import { createApp } from "../../src/app";
import type { AgentConnectors } from "../../src/connectors/agent-connectors";
import type { Ledger } from "../../src/context";
import { ServiceCredentials, issueWorkerCredential } from "../../src/auth/credentials";
import type { SessionSettings } from "../../src/auth/session";
import { createIntegration, type Integration } from "../../src/integration";
import { UnavailableFundingProvider } from "../../src/integration/funding";
import { GatewayClient, type FetchLike } from "../../src/integration/gateway-client";
import { PermitSigner } from "../../src/integration/permits";
import { activateDefaults, addNotes, createEnv, type TestEnv } from "../helpers";
import { TestFundingProvider } from "./test-funding-provider";
import type { AiService } from "../../src/ai/service";

const config = loadConfig({
  DEVNET_RPC_URL: "https://rpc.test.invalid",
  EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH,
  DEMO_TOKEN_MINT,
  FACILITATOR_URL: "https://facilitator.payai.network",
});

export const ORIGIN = "http://localhost:3000";
export const PLANNING_TOKEN = "planning-token-for-tests-0001";

export type Responder = (request: ChatRequest) => string | { kind: "definite"; status: number } | { kind: "ambiguous" } | undefined;

/**
 * FIXTURE provider that answers by request type: content packages get a schema-valid JSON
 * package for the requested channels; everything else gets labeled fixture text. Tests can
 * install a responder to script planning or hostile outputs.
 */
export class ScriptedProvider extends FixtureProvider {
  responder: Responder | undefined;
  override async complete(request: ChatRequest): Promise<ChatResult> {
    const scripted = this.responder?.(request);
    if (scripted !== undefined) {
      this.behavior = typeof scripted === "string" ? { kind: "text", text: scripted } : scripted;
      return super.complete(request);
    }
    const system = request.messages[0]?.content ?? "";
    if (system.includes("Return only a JSON object")) {
      const channels = /Channels: (.*)/.exec(request.messages[1]?.content ?? "")?.[1]?.split(", ") ?? ["LinkedIn", "Newsletter", "Instagram"];
      const pkg = JSON.parse(VALID_CONTENT) as { drafts: Array<{ channel: string; title: string; body: string }>; calendar: Array<{ day: number; channel: string; draftIndex: number | null; action: string }> };
      pkg.drafts = pkg.drafts.map((d, i) => ({ ...d, channel: channels[i] ?? d.channel, title: `FIXTURE draft ${i + 1}`, body: `FIXTURE body for ${channels[i]}` }));
      pkg.calendar = pkg.calendar.map((c) => ({ ...c, channel: channels[(c.day - 1) % 3] ?? c.channel, action: c.draftIndex === null ? "engage and review" : "post draft" }));
      this.behavior = { kind: "text", text: JSON.stringify(pkg) };
    } else {
      this.behavior = { kind: "text", text: "FIXTURE analysis: repair cafes reduce waste [1]; tool libraries grew by word of mouth [3]." };
    }
    return super.complete(request);
  }
}

export interface Stack {
  gw: Harness;
  env: TestEnv;
  provider: ScriptedProvider;
  funding: FundingProvider;
  testFunding: TestFundingProvider;
  integration: Integration;
  gatewayClient: GatewayClient;
  base: string;
  server: Server;
  accountId: string;
  /** Fails matching gateway requests: "before" never reaches the gateway, "after" loses the reply. */
  faults: Array<{ match: RegExp; when: "before" | "after"; remaining: number }>;
  login(): Promise<{ cookie: string; csrf: string }>;
  ownerHeaders(s: { cookie: string; csrf: string }): Record<string, string>;
  worker(agent: "Shawn" | "Prince" | "Mira"): string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any }>;
  restart(): Promise<void>;
  close(): Promise<void>;
  count(sql: string, ...args: unknown[]): number;
  gwCount(sql: string, ...args: unknown[]): number;
}

export interface StackOptions {
  funding?: "test" | "unavailable";
  agents?: Partial<Record<"Shawn" | "Prince" | "Mira", Partial<AgentPolicyInput>>>;
  workspace?: Partial<WorkspacePolicyInput>;
  notes?: bigint[];
  leaseMs?: number;
  purchaseSweepMs?: number;
  settleWaitMs?: number;
  settlePollMs?: number;
  /** Agent connectors for the app; absent means the routes answer NOT_READY. */
  connectors?: (ledger: Ledger) => AgentConnectors;
  /** The owner's model provider (BYOK); absent means agents fall back to sponsored planning and paid AI. */
  ai?: (ledger: Ledger) => AiService;
  channels?: (ledger: Ledger) => ChannelService;
}

export async function makeStack(options: StackOptions = {}): Promise<Stack> {
  const provider = new ScriptedProvider();
  const gw = await makeHarness({ provider });
  const env = createEnv();
  env.ledger.now = () => gw.clock.t;
  activateDefaults(env, { ...(options.agents ? { agents: options.agents } : {}), ...(options.workspace ? { workspace: options.workspace } : {}) });
  addNotes(env, options.notes ?? [5_000_000n, 5_000_000n, 5_000_000n, 5_000_000n]);
  const merchantAta = gw.gateway.ctx.acceptance.merchantAta as string;
  env.db
    .prepare(
      `UPDATE approved_service SET status = 'approved', gateway_identity = 'veilo-gateway-devnet', recipient = ?, recipient_ata = ?, updated_at_ms = ? WHERE workspace_id = ?`,
    )
    .run(gw.merchant.address, merchantAta, env.ledger.now(), env.ws.id);
  const account = gw.account(env.ws.id);

  const faults: Stack["faults"] = [];
  const faultyFetch: FetchLike = async (input, init) => {
    const f = faults.find((x) => x.remaining > 0 && x.match.test(`${init?.method ?? "GET"} ${input}`));
    if (f?.when === "before") {
      f.remaining -= 1;
      throw new TypeError("fetch failed (injected before delivery)");
    }
    const res = await fetch(input, init);
    if (f?.when === "after") {
      f.remaining -= 1;
      await res.text();
      throw new TypeError("fetch failed (injected reply loss)");
    }
    return res;
  };
  const gatewayClient = new GatewayClient({ baseUrl: gw.base, accountToken: account.token, planningToken: PLANNING_TOKEN, identity: "veilo-gateway-devnet", fetch: faultyFetch });
  const testFunding = new TestFundingProvider(() => gw.clock.t);
  const funding: FundingProvider = options.funding === "unavailable" ? new UnavailableFundingProvider() : testFunding;
  const permits = PermitSigner.fromPem(gw.permitPem.privateKeyPem);
  const session: SessionSettings = { domain: "localhost:3000", origin: ORIGIN, chainId: DEVNET_CAIP2, challengeTtlMs: 300_000, sessionTtlMs: 3_600_000, secureCookies: false };

  const build = () => createIntegration(env.ledger, { gateway: gatewayClient, permits, funding, ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}), ...(options.purchaseSweepMs !== undefined ? { purchaseSweepMs: options.purchaseSweepMs } : {}), ...(options.settleWaitMs !== undefined ? { settleWaitMs: options.settleWaitMs } : {}), ...(options.settlePollMs !== undefined ? { settlePollMs: options.settlePollMs } : {}) });
  const listen = async (integration: Integration) => {
    const app = createApp(createServiceHealth("control", config, false), { ledger: env.ledger, session, services: new ServiceCredentials([]), log: () => undefined, integration, connectors: options.connectors?.(env.ledger), ai: options.ai?.(env.ledger), channels: options.channels?.(env.ledger) });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    return server;
  };
  const integration = build();
  const server = await listen(integration);
  const tokens = new Map<string, string>();

  const stack: Stack = {
    gw,
    env,
    provider,
    funding,
    testFunding,
    integration,
    gatewayClient,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    accountId: account.accountId,
    faults,
    async call(path, init = {}) {
      const res = await fetch(`${stack.base}${path}`, {
        method: init.method ?? "GET",
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : {} };
    },
    async login() {
      const ch = await stack.call("/session/challenge", { method: "POST", body: { address: env.owner.address } });
      const verify = await fetch(`${stack.base}/session/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: env.owner.address, nonce: ch.body.nonce, signature: env.owner.signText(ch.body.message) }),
      });
      const body = (await verify.json()) as { csrfToken: string };
      const token = /veilo_session=([^;]+)/.exec(verify.headers.get("set-cookie") ?? "")?.[1];
      return { cookie: `veilo_session=${token}`, csrf: body.csrfToken };
    },
    ownerHeaders: (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrf, origin: ORIGIN }),
    worker(agent) {
      const existing = tokens.get(agent);
      if (existing) return existing;
      const t = issueWorkerCredential(env.ledger, env.ws.id, env.agents[agent].id, "owner").token;
      tokens.set(agent, t);
      return t;
    },
    async restart() {
      await new Promise<void>((r) => stack.server.close(() => r()));
      stack.integration.scheduler.stop();
      stack.integration = build();
      await stack.integration.scheduler.reconcileExpired();
      await stack.integration.orchestrator.reconcileAll();
      stack.server = await listen(stack.integration);
      stack.base = `http://127.0.0.1:${(stack.server.address() as AddressInfo).port}`;
    },
    async close() {
      stack.integration.scheduler.stop();
      await new Promise<void>((r) => stack.server.close(() => r()));
      await gw.close();
      env.cleanup();
    },
    count: (sql, ...args) => Number(env.db.prepare(sql).pluck().get(...args)),
    gwCount: (sql, ...args) => Number(gw.db.prepare(sql).pluck().get(...args)),
  };
  return stack;
}
