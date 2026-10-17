// TEST ONLY. Boots control (real ledger, routes, orchestrator and marketplace bridge) against a
// fake signed marketplace and a fake seller host. Funding is synthetic: no proof, pool
// withdrawal or chain transaction happens, and every "finalized" result is fabricated here.
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { generateKeyPairSigner, getAddressDecoder, getBase58Decoder } from "@solana/kit";
import {
  DEMO_TOKEN_DECIMALS,
  DEMO_TOKEN_MINT,
  DEVNET_CAIP2,
  DEVNET_GENESIS_HASH,
  createServiceHealth,
  loadConfig,
  type AgentPolicyInput,
  type FundingProvider,
  type FundingRequest,
  type FundingResult,
  type MerchantSignRequest,
  type MerchantSignResult,
  type PayerBindingRequest,
  type PayerBindingResult,
  type WorkspacePolicyInput,
} from "@veilo/contracts";
import { computeInputDigest, computeQuoteDigest, payerBindingMessage, type MarketplaceQuote, type PaymentRequest, type QuoteFields } from "@veilo/contracts/marketplace";
import { immediate } from "@veilo/db";
import { createApp } from "../../src/app";
import { ServiceCredentials, issueWorkerCredential } from "../../src/auth/credentials";
import type { SessionSettings } from "../../src/auth/session";
import { createIntegration, type Integration } from "../../src/integration";
import { deriveAta } from "../../src/marketplace/addresses";
import { MarketplaceClient } from "../../src/marketplace/client";
import { ControllerIdentity } from "../../src/marketplace/controller-identity";
import { SellerOriginPolicy } from "../../src/marketplace/origin-policy";
import { SellerClients } from "../../src/marketplace/seller-clients";
import { activatePolicyVersion, insertAgent, type AgentRow } from "../../src/ledger/workspace";
import { activateDefaults, addNotes, createEnv, type TestEnv } from "../helpers";
import { FakeMarketplace } from "./fake-marketplace";
import { FakeSellerHost } from "./fake-seller-host";

const config = loadConfig({
  DEVNET_RPC_URL: "https://rpc.test.invalid",
  EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH,
  DEMO_TOKEN_MINT,
  FACILITATOR_URL: "https://facilitator.payai.network",
});

export const ORIGIN = "http://localhost:3000";
export const PRICE = 600_000n;

/** Synthetic funding: finalizes immediately and signs one fake payment header per purchase. */
export class SyntheticFunding implements FundingProvider {
  readonly mode = "test" as const;
  readonly calls = { prepare: 0, release: 0, sign: 0 };
  readonly signedPayers: string[] = [];
  payers(): string[] {
    return [...this.#entries.values()].map((e) => e.payer);
  }
  readonly #entries = new Map<string, { req: FundingRequest; ref: string; payer: string; key: KeyObject; result: FundingResult; signed?: MerchantSignResult }>();
  readonly bindings: string[] = [];
  constructor(private readonly now: () => number) {}

  async prepare(req: FundingRequest): Promise<FundingResult> {
    this.calls.prepare += 1;
    const e = this.#entries.get(req.purchaseId);
    if (e) return { status: "prepared", fundingRef: e.ref, payer: e.payer };
    const ref = `testfund_${randomBytes(6).toString("hex")}`;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const payer = getAddressDecoder().decode(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"));
    this.#entries.set(req.purchaseId, { req, ref, payer, key: privateKey, result: { status: "prepared", fundingRef: ref, payer } });
    return { status: "prepared", fundingRef: ref, payer };
  }

  async release(purchaseId: string): Promise<FundingResult> {
    this.calls.release += 1;
    const e = this.#entries.get(purchaseId);
    if (!e) return { status: "recovery_required", reason: "unknown purchase" };
    if (e.result.status === "prepared") {
      const change = e.req.inputNote.value - e.req.payoutUsdc;
      e.result = {
        status: "finalized",
        fundingRef: e.ref,
        evidence: {
          payout: e.req.payoutUsdc,
          tokenFees: 0n,
          change,
          changeCommitment: change > 0n ? createHash("sha256").update(`change:${e.ref}`).digest("hex") : null,
          observedAtMs: this.now(),
          signature: `TESTFUND${randomBytes(20).toString("hex")}`,
          sponsorLamportsSpent: 2_039_280n,
        },
      };
    }
    return e.result;
  }

  async signPayerBinding(req: PayerBindingRequest): Promise<PayerBindingResult> {
    const e = this.#entries.get(req.purchaseId);
    if (!e || req.fundingRef !== e.ref) return { status: "refused", reason: "no funding for this purchase" };
    if (e.result.status !== "prepared") return { status: "refused", reason: "already released" };
    this.bindings.push(req.purchaseId);
    const proof = getBase58Decoder().decode(sign(null, Buffer.from(payerBindingMessage(req.operationId, req.quoteDigest, e.payer), "utf8"), e.key));
    return { status: "signed", payer: e.payer, proof };
  }

  async status(purchaseId: string): Promise<FundingResult> {
    return this.#entries.get(purchaseId)?.result ?? { status: "not_ready", reason: "unknown purchase" };
  }

  async signMerchantPayment(req: MerchantSignRequest): Promise<MerchantSignResult> {
    const e = this.#entries.get(req.purchaseId);
    if (!e || e.result.status !== "finalized") return { status: "recovery_required", reason: "funding not finalized" };
    if (e.signed) return e.signed;
    const accepted = (req.paymentRequired as { accepts?: Array<{ amount: string; payTo: string }> } | null)?.accepts?.[0];
    if (!accepted || BigInt(accepted.amount) !== req.exactAmountUsdc || accepted.payTo !== req.binding.payTo) {
      return { status: "recovery_required", reason: "challenge does not match the binding" };
    }
    this.calls.sign += 1;
    const header = `testpay.${req.purchaseId}`;
    this.signedPayers.push(e.payer);
    e.signed = { status: "signed", paymentSignatureHeader: header, payer: e.payer, messageHash: createHash("sha256").update(header).digest("hex") };
    return e.signed;
  }
}

export const SCOUT_POLICY: AgentPolicyInput = {
  tier: "bounded_automatic",
  lifetimeTestUsdc: "2000000",
  rolling24hTestUsdc: "2000000",
  maxPurchaseTestUsdc: "1000000",
  taskLimitTestUsdc: "1000000",
  usageAllowanceUnits: "0",
  taskCreditUnits: "0",
  allowedSkus: ["specialist-job"],
  allowedPaymentPaths: ["private_x402"],
};

export interface MarketStackOptions {
  scoutPolicy?: Partial<AgentPolicyInput>;
  workspace?: Partial<WorkspacePolicyInput>;
  allowSellerOrigin?: boolean;
  maxPaymentUnits?: bigint;
  notes?: bigint[];
}

export interface MarketStack {
  env: TestEnv;
  scout: AgentRow;
  market: FakeMarketplace;
  seller: FakeSellerHost;
  funding: SyntheticFunding;
  identity: ControllerIdentity;
  sellers: SellerClients;
  integration: Integration;
  base: string;
  server: Server;
  recipient: string;
  recipientAta: string;
  cloudWorkspaceId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any }>;
  login(): Promise<{ cookie: string; csrf: string }>;
  ownerHeaders(s: { cookie: string; csrf: string }): Record<string, string>;
  worker(agentId: string): string;
  /** A valid payment request; `edit` may tamper fields, and `redigest` recomputes the quote digest. */
  request(o?: { brief?: string; requestedBy?: PaymentRequest["requestedBy"]; edit?: (q: QuoteFields) => void; redigest?: boolean; operationId?: string; listingId?: string }): PaymentRequest;
  count(sql: string, ...args: unknown[]): number;
  close(): Promise<void>;
}

export async function makeMarketStack(o: MarketStackOptions = {}): Promise<MarketStack> {
  const env = createEnv();
  activateDefaults(env, o.workspace ? { workspace: o.workspace } : {});
  addNotes(env, o.notes ?? [5_000_000n, 5_000_000n, 5_000_000n, 5_000_000n]);
  const scout = immediate(env.ledger.db, () =>
    insertAgent(env.ledger, env.ws.id, { name: "Scout", role: "custom", template: "researcher", instructions: "Find a specialist for the owner's question.", policy: { ...SCOUT_POLICY, ...o.scoutPolicy } }, "owner"),
  );
  activatePolicyVersion(env.ledger, env.ws.id, scout.id, 1, { type: "owner", id: "owner" });

  const payTo = (await generateKeyPairSigner()).address;
  const merchantAta = await deriveAta(payTo, env.ws.mint);
  const seller = await new FakeSellerHost({ identity: "seller-host-test", network: env.ws.network, mint: env.ws.mint, payTo, merchantAta, price: PRICE }, () => env.clock.t).start();
  const market = await new FakeMarketplace().start();
  const identity = ControllerIdentity.loadOrCreate(join(env.dir, "secrets", "control", "marketplace-controller.pem"));
  market.register(identity.publicKey, identity.keyId);
  const policy = new SellerOriginPolicy({ localTestOrigins: o.allowSellerOrigin === false ? [] : [seller.origin] });
  const sellers = new SellerClients({ policy, tokenDir: join(env.dir, "secrets", "control", "seller-accounts") });
  const funding = new SyntheticFunding(() => env.clock.t);
  const integration = createIntegration(env.ledger, {
    gateway: undefined,
    permits: undefined,
    funding,
    marketplace: {
      client: new MarketplaceClient({ baseUrl: market.base, identity }),
      identity,
      sellers,
      chain: { network: DEVNET_CAIP2, genesisHash: DEVNET_GENESIS_HASH, mint: DEMO_TOKEN_MINT, decimals: DEMO_TOKEN_DECIMALS },
      maxPaymentUnits: o.maxPaymentUnits ?? 1_000_000n,
    },
  });
  const session: SessionSettings = { domain: "localhost:3000", origin: ORIGIN, chainId: DEVNET_CAIP2, challengeTtlMs: 300_000, sessionTtlMs: 3_600_000, secureCookies: false };
  const app = createApp(createServiceHealth("control", config, false), { ledger: env.ledger, session, services: new ServiceCredentials([]), log: () => undefined, integration });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const cloudWorkspaceId = randomUUID();
  const tokens = new Map<string, string>();

  const stack: MarketStack = {
    env,
    scout,
    market,
    seller,
    funding,
    identity,
    sellers,
    integration,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    recipient: payTo,
    recipientAta: merchantAta,
    cloudWorkspaceId,
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
    worker(agentId) {
      const existing = tokens.get(agentId);
      if (existing) return existing;
      const t = issueWorkerCredential(env.ledger, env.ws.id, agentId, "owner").token;
      tokens.set(agentId, t);
      return t;
    },
    request(r = {}) {
      const brief = r.brief ?? "Summarize the attached market notes into a one-page brief.";
      const operationId = r.operationId ?? `op_${randomBytes(6).toString("hex")}`;
      const fields: QuoteFields = {
        id: randomUUID(),
        operationId,
        buyerWorkspaceId: cloudWorkspaceId,
        jobId: randomUUID(),
        listingVersionId: "11111111-1111-4111-8111-111111111111",
        runtimeVersion: "rt-1",
        inputDigest: computeInputDigest(brief),
        network: DEVNET_CAIP2,
        genesisHash: DEVNET_GENESIS_HASH,
        mint: DEMO_TOKEN_MINT,
        decimals: DEMO_TOKEN_DECIMALS,
        recipient: payTo,
        recipientAta: merchantAta,
        sellerOrigin: seller.origin,
        sellerIdentity: "seller-host-test",
        baseUnits: PRICE.toString(),
        feeBps: 0,
        feeUnits: "0",
        totalUnits: PRICE.toString(),
        maxNetworkFeeLamports: "10000",
        termsVersion: "v1",
        expiresAt: new Date(env.clock.t + 300_000).toISOString(),
      };
      const digest = computeQuoteDigest(fields);
      r.edit?.(fields);
      const quote: MarketplaceQuote = { ...fields, quoteDigest: r.redigest === false ? digest : computeQuoteDigest(fields) };
      market.knownDigests.set(operationId, quote.quoteDigest);
      return {
        operationId,
        jobId: fields.jobId,
        quote,
        brief,
        briefDigest: computeInputDigest(brief),
        listing: { listingId: r.listingId ?? "22222222-2222-4222-8222-222222222222", slug: "market-brief", title: "Market brief", sellerName: "Seller" },
        requestedBy: r.requestedBy ?? { kind: "owner", agentId: null, localAgentId: null },
        ownerApprovedAt: new Date(env.clock.t).toISOString(),
      };
    },
    count: (sql, ...args) => Number(env.db.prepare(sql).pluck().get(...args)),
    async close() {
      integration.scheduler.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await market.close();
      await seller.close();
      env.cleanup();
    },
  };
  return stack;
}
