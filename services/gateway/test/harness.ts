import type { GatewayContext } from "../src/context";
import type { ToolProvider } from "@veilo/contracts/marketplace";
import type { ProviderAdapter } from "../src/seller-host/providers";
// Test-only harness: fake chain, facilitator and FIXTURE provider. Not used by the service.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type KeyPairSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { DEMO_TOKEN_MINT, DEVNET_CAIP2, createServiceHealth, loadConfig, DEVNET_GENESIS_HASH } from "@veilo/contracts";
import { computeRequestDigest, generateUsagePermitKeyPair, loadUsagePermitPrivateKey, loadUsagePermitPublicKey, signUsagePermit, type UsagePermitPayload } from "@veilo/contracts/gateway";
import { decodeWireTransaction, deriveAta, messageHashOf } from "@veilo/x402-client";
import { createApp } from "../src/app";
import type { AccountRateLimit } from "../src/seller-host/accounts";
import { MarketplaceClient } from "../src/seller-host/marketplace-client";
import { createAccount, hashToken } from "../src/auth";
import type { GatewayChain, ObservedTransaction } from "../src/chain";
import type { GatewayFacilitator, GatewayHooks } from "../src/context";
import { openGatewayDb, type GatewayDb } from "../src/db/database";
import { Gateway } from "../src/gateway";
import { ProviderError, type ChatProvider, type ChatRequest, type ChatResult } from "../src/provider/types";

export const MINT = address(DEMO_TOKEN_MINT);

export class FakeClock {
  t = Date.parse("2026-10-15T00:00:00Z");
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

export class FakeChain implements GatewayChain {
  blockhash!: string;
  lastValidBlockHeight = 1_000n;
  height = 900n;
  txs = new Map<string, { messageHash: string; err: unknown; slot: bigint; finalized: boolean; payer: string }>();
  rpcDown = false;

  async init() {
    this.blockhash = (await generateKeyPairSigner()).address;
    return this;
  }
  land(sig: string, messageHash: string, payer: string, finalized = true, err: unknown = null) {
    this.txs.set(sig, { messageHash, err, slot: 500n, finalized, payer });
  }
  async getLatestBlockhash() {
    if (this.rpcDown) throw new Error("rpc down");
    return { blockhash: this.blockhash, lastValidBlockHeight: this.lastValidBlockHeight };
  }
  async getFinalizedBlockHeight() {
    if (this.rpcDown) throw new Error("rpc down");
    return this.height;
  }
  async getTransaction(sig: string, commitment: "confirmed" | "finalized"): Promise<ObservedTransaction | null> {
    if (this.rpcDown) throw new Error("rpc down");
    const tx = this.txs.get(sig);
    if (!tx || (commitment === "finalized" && !tx.finalized)) return null;
    return { slot: tx.slot, err: tx.err, messageHash: tx.messageHash, commitment };
  }
  async getSignaturesForAddress(addr: string) {
    if (this.rpcDown) throw new Error("rpc down");
    return [...this.txs.entries()].filter(([, t]) => t.payer === addr).map(([s]) => s);
  }
}

export type SettleMode = "success" | "lost_response" | "not_landed" | "fail";

export class FakeFacilitator implements GatewayFacilitator {
  feePayer!: KeyPairSigner;
  settleMode: SettleMode = "success";
  verifyValid = true;
  supportedKinds: SupportedResponse["kinds"] | undefined;
  verifyCalls = 0;
  settleCalls = 0;
  constructor(private readonly chain: FakeChain) {}

  async init() {
    this.feePayer = await generateKeyPairSigner();
    return this;
  }
  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: this.supportedKinds ?? [{ x402Version: 2, scheme: "exact", network: DEVNET_CAIP2, extra: { feePayer: this.feePayer.address } }],
      extensions: [],
      signers: { "solana:*": [this.feePayer.address] },
    };
  }
  async verify(): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    return { isValid: this.verifyValid, ...(this.verifyValid ? {} : { invalidReason: "invalid_exact_svm_payload" }) };
  }
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls += 1;
    const tx = decodeWireTransaction(payload.payload.transaction as string);
    const hash = messageHashOf(new Uint8Array(tx.messageBytes));
    const payer = Object.keys(tx.signatures).find((k) => k !== this.feePayer.address) as string;
    // Deterministic, well-formed base58 signature derived from the message hash.
    const sig = getBase58Decoder().decode(createHash("sha512").update(hash).digest());
    if (this.settleMode === "fail") return { success: false, errorReason: "transaction_failed", transaction: "", network: requirements.network };
    if (this.settleMode !== "not_landed") this.chain.land(sig, hash, payer);
    if (this.settleMode === "lost_response") throw new Error("socket hang up");
    if (this.settleMode === "not_landed") throw new Error("timeout");
    return { success: true, transaction: sig, network: requirements.network, payer };
  }
}

export type ProviderBehavior =
  | { kind: "text"; text: string }
  | { kind: "definite"; status: number }
  | { kind: "ambiguous" };

/** FIXTURE provider: deterministic, labeled fixture mode. Never real inference. */
export class FixtureProvider implements ChatProvider {
  readonly mode = "fixture" as const;
  calls: ChatRequest[] = [];
  behavior: ProviderBehavior = { kind: "text", text: "FIXTURE summary." };
  async complete(request: ChatRequest): Promise<ChatResult> {
    this.calls.push(request);
    const b = this.behavior;
    if (b.kind === "definite") throw new ProviderError("definite", `fixture HTTP ${b.status}`, b.status);
    if (b.kind === "ambiguous") throw new ProviderError("ambiguous", "fixture timeout");
    return {
      text: b.text,
      httpStatus: 200,
      reportedModel: request.model,
      generationId: "gen-fixture",
      finishReason: "stop",
      promptTokens: 50,
      completionTokens: 20,
      costMicro: 3n,
    };
  }
}

export const MODEL = "mistralai/mistral-nemo";

export function pricingFetch(prices: { prompt: string; completion: string } | "down" = { prompt: "0.000000029", completion: "0.00000003" }) {
  return async () => {
    if (prices === "down") throw new Error("network down");
    return new Response(JSON.stringify({ data: [{ id: MODEL, pricing: prices }] }), { status: 200 });
  };
}

export const VALID_CONTENT = JSON.stringify({
  drafts: [
    { channel: "LinkedIn", title: "t1", body: "b1" },
    { channel: "Newsletter", title: "t2", body: "b2" },
    { channel: "Instagram", title: "t3", body: "b3" },
  ],
  calendar: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, channel: "LinkedIn", draftIndex: day <= 3 ? day - 1 : null, action: "post" })),
});

export interface HarnessOptions {
  dbPath?: string;
  ceilingMicro?: bigint;
  hooks?: GatewayHooks;
  prices?: Parameters<typeof pricingFetch>[0];
  provider?: FixtureProvider | null;
  /** Runs the gateway in the seller-host role against a (fake) marketplace. */
  sellerHost?: { marketplaceUrl: string; token: string; allowedRecipients?: string[] };
  providers?: ReadonlyMap<ToolProvider, ProviderAdapter>;
  mcp?: GatewayContext["mcp"];
  accountRateLimit?: AccountRateLimit;
  shared?: { chain: FakeChain; facilitator: FakeFacilitator; merchant: KeyPairSigner; clock: FakeClock; permitPem: { privateKeyPem: string; publicKeyPem: string } };
}

export async function makeHarness(options: HarnessOptions = {}) {
  const dbPath = options.dbPath ?? join(mkdtempSync(join(tmpdir(), "veilo-gw-")), "gateway.sqlite");
  const chain = options.shared?.chain ?? (await new FakeChain().init());
  const facilitator = options.shared?.facilitator ?? (await new FakeFacilitator(chain).init());
  const merchant = options.shared?.merchant ?? (await generateKeyPairSigner());
  const clock = options.shared?.clock ?? new FakeClock();
  const permitPem = options.shared?.permitPem ?? generateUsagePermitKeyPair();
  const provider = options.provider === undefined ? new FixtureProvider() : options.provider;
  const db: GatewayDb = openGatewayDb(dbPath);
  const config = loadConfig({
    DEVNET_RPC_URL: "https://rpc.test.invalid",
    EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH,
    DEMO_TOKEN_MINT,
    FACILITATOR_URL: "https://facilitator.test.invalid",
  });
  const gateway = new Gateway({
    db,
    settings: {
      role: options.sellerHost ? "seller-host" : "operator",
      identity: options.sellerHost ? "veilo-seller-host-devnet" : "veilo-gateway-devnet",
      origin: options.sellerHost ? "http://127.0.0.1:4106" : "http://127.0.0.1:4104",
      network: DEVNET_CAIP2,
      genesisHash: DEVNET_GENESIS_HASH,
      mint: MINT,
      mintDecimals: 6,
      facilitatorUrl: "https://facilitator.test.invalid",
      merchantAddress: options.sellerHost ? undefined : merchant.address,
      merchantAta: undefined,
      feePayer: facilitator.feePayer.address,
      quoteTtlSeconds: 600,
      settlementWaitMs: 0,
      settlementPollMs: 0,
      maxTimeoutSeconds: 300,
      operatorCeilingMicro: options.ceilingMicro ?? 1_000_000n,
      sellerHost: options.sellerHost
        ? { allowedRecipients: options.sellerHost.allowedRecipients ?? [], heartbeatMs: 5, claimRetryDelaysMs: [10, 20, 40] }
        : undefined,
    },
    chain,
    facilitator,
    provider,
    inferenceModelId: MODEL,
    plannerModelId: MODEL,
    pricingFetch: pricingFetch(options.prices),
    pricingMaxAgeSeconds: 3600,
    providerTimeoutMs: 5_000,
    permitPublicKey: loadUsagePermitPublicKey(permitPem.publicKeyPem),
    planningTokenHash: hashToken("planning-token-for-tests-0001"),
    serviceHealth: { ...createServiceHealth("gateway", config, false) },
    now: clock.now,
    sleep: async () => undefined,
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.sellerHost ? { marketplace: new MarketplaceClient({ baseUrl: options.sellerHost.marketplaceUrl, token: options.sellerHost.token }) } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
    ...(options.mcp ? { mcp: options.mcp } : {}),
  });
  await gateway.refreshExternal();
  const server: Server = createApp(gateway, options.accountRateLimit ? { accountRateLimit: options.accountRateLimit } : {}).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const privateKey = loadUsagePermitPrivateKey(permitPem.privateKeyPem);

  const h = {
    db,
    dbPath,
    gateway,
    chain,
    facilitator,
    merchant,
    clock,
    provider,
    permitPem,
    base,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
    account(workspace = `ws-${Math.random().toString(36).slice(2)}`) {
      return createAccount(db, workspace, "control-service");
    },
    async call(method: string, path: string, token: string | undefined, body?: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return {
        status: res.status,
        headers: res.headers,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are asserted field by field
        body: (text ? JSON.parse(text) : undefined) as any,
      };
    },
    async quote(token: string, sku: string, input: unknown, operationId = `op-${Math.random().toString(36).slice(2)}`) {
      const requestDigest = computeRequestDigest(sku, input);
      const r = await h.call("POST", "/quotes", token, { operationId, sku, input, requestDigest });
      return { ...r, operationId, requestDigest };
    },
    async challenge(token: string, quote: { quoteId: string; operationId: string; requestDigest: string }) {
      const r = await h.call("POST", `/v1/purchases/${quote.quoteId}/execute`, token, {
        operationId: quote.operationId,
        requestDigest: quote.requestDigest,
      });
      return { ...r, paymentRequired: r.status === 402 ? decodePaymentRequiredHeader(r.headers.get("payment-required") as string) : undefined };
    },
    async pay(token: string, quote: { quoteId: string; operationId: string; requestDigest: string }, header: string) {
      return h.call("POST", `/v1/purchases/${quote.quoteId}/execute`, token, { operationId: quote.operationId, requestDigest: quote.requestDigest }, {
        "payment-signature": header,
      });
    },
    permit(overrides: Partial<UsagePermitPayload> & Pick<UsagePermitPayload, "accountId" | "sku" | "units" | "requestDigest" | "operationId">) {
      const iat = Math.floor(clock.t / 1000);
      return signUsagePermit(
        { v: 1, typ: "usage-permit", aud: "veilo-gateway-devnet", nonce: `n-${Math.random().toString(36).slice(2)}`, scope: "agent:prince/task:t1", iat, exp: iat + 120, ...overrides },
        privateKey,
      );
    },
  };
  return h;
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>;

/** Builds a payment answering `pr` from a fresh payer, in the SDK layout, with overrides. */
export async function buildPaymentHeader(
  pr: PaymentRequired,
  o: { amount?: bigint; payer?: KeyPairSigner; destinationOwner?: string } = {},
): Promise<{ header: string; payer: KeyPairSigner }> {
  const req = pr.accepts[0] as PaymentRequirements;
  const payer = o.payer ?? (await generateKeyPairSigner());
  const source = await deriveAta(payer.address, MINT);
  const destination = await deriveAta(o.destinationOwner ?? req.payTo, MINT);
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(req.extra.feePayer as string), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: req.extra.recentBlockhash as Blockhash, lastValidBlockHeight: BigInt(req.extra.lastValidBlockHeight as string) },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: 20_000 }),
          getSetComputeUnitPriceInstruction({ microLamports: 1n }),
          getTransferCheckedInstruction(
            { source, mint: MINT, destination, authority: payer, amount: o.amount ?? BigInt(req.amount), decimals: 6 },
            { programAddress: TOKEN_PROGRAM_ADDRESS },
          ),
          { programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), data: new TextEncoder().encode("00112233445566778899aabbccddeeff") },
        ],
        m,
      ),
  );
  const signed = await partiallySignTransactionMessageWithSigners(msg);
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted: req,
    payload: { transaction: getBase64EncodedWireTransaction(signed) },
  };
  return { header: encodePaymentSignatureHeader(payload), payer };
}
