import { generateKeyPairSigner, getBase64Decoder, none, some } from "@solana/kit";
import { getMintEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired, SupportedResponse } from "@x402/core/types";
import { createDevnetRpc, DEVNET_CAIP2 } from "@veilo/contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyPaymentRequired, type ApprovedServiceBinding } from "../src/binding";
import { X402ClientError } from "../src/errors";
import { checkFacilitatorSupport } from "../src/facilitator";
import { preparePayment } from "../src/pay";
import { keyPairPaymentWallet, type FreshPaymentWallet } from "../src/signer";
import { makeParties, MINT, type Parties } from "./helpers";

const RPC_URL = "https://rpc.devnet.test.invalid";
let p: Parties;
let binding: ApprovedServiceBinding;
let challenge: PaymentRequired;

function mintAccountData(): string {
  const bytes = getMintEncoder().encode({
    mintAuthority: some(MINT),
    supply: 0n,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: none(),
  });
  return getBase64Decoder().decode(bytes);
}

/** Fake devnet RPC that serves only the mint account; any other method fails the test. */
function stubRpc() {
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    if (body.method !== "getAccountInfo") throw new Error(`unexpected RPC ${body.method}`);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          context: { slot: 1 },
          value: {
            data: [mintAccountData(), "base64"],
            executable: false,
            lamports: 1_461_600,
            owner: TOKEN_PROGRAM_ADDRESS,
            rentEpoch: 0,
            space: 82,
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeAll(async () => {
  p = await makeParties();
  binding = {
    origin: "http://127.0.0.1:4104",
    resourceUrl: "http://127.0.0.1:4104/v1/purchases/q-1/execute",
    gatewayIdentity: "veilo-gateway-devnet",
    sku: "summarize",
    network: DEVNET_CAIP2,
    mint: MINT,
    payTo: p.merchant.address,
    merchantAta: p.merchantAta,
    maxAmount: 100_000n,
    exactAmount: 100_000n,
    allowedFeePayers: [p.feePayer.address],
  };
  challenge = {
    x402Version: 2,
    resource: {
      url: "http://127.0.0.1:4104/v1/purchases/q-1/execute",
      serviceName: "veilo-gateway-devnet",
      tags: ["veilo-sku:summarize"],
    },
    accepts: [
      {
        scheme: "exact",
        network: DEVNET_CAIP2,
        asset: MINT,
        amount: "100000",
        payTo: p.merchant.address,
        maxTimeoutSeconds: 300,
        extra: { feePayer: p.feePayer.address, recentBlockhash: p.blockhash, lastValidBlockHeight: "1000" },
      },
    ],
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function countingWallet(): FreshPaymentWallet & { calls: number } {
  const inner = keyPairPaymentWallet(p.payer);
  const w = {
    address: inner.address,
    calls: 0,
    async signPaymentMessage(req: Parameters<FreshPaymentWallet["signPaymentMessage"]>[0]) {
      w.calls += 1;
      return inner.signPaymentMessage(req);
    },
  };
  return w;
}

describe("x402 client adapter", () => {
  it("builds one validated payment through the SDK and encodes it with the protocol encoder", async () => {
    const rpc = stubRpc();
    const wallet = countingWallet();
    const prepared = await preparePayment({ paymentRequired: challenge, binding, wallet, purchaseRef: "op-1", rpcUrl: RPC_URL });
    expect(wallet.calls).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    const header = prepared.headers["PAYMENT-SIGNATURE"];
    expect(typeof header).toBe("string");
    const decoded = decodePaymentSignatureHeader(header as string);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepted).toEqual(challenge.accepts[0]);
    expect(prepared.validated.payer).toBe(p.payer.address);
    expect(prepared.validated.amount).toBe(100_000n);
    expect(prepared.validated.recentBlockhash).toBe(p.blockhash);
  });

  it("reads the mint only through a supplied retrying RPC, across a 429", async () => {
    const RETRYING_URL = "https://retrying.devnet.test.invalid/";
    const served = stubRpc();
    let rejected = 0;
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      if (rejected === 0) {
        rejected += 1;
        return new Response("Too Many Requests", { status: 429, statusText: "Too Many Requests" });
      }
      return served(url, init);
    });
    const wallet = countingWallet();
    const prepared = await preparePayment({
      paymentRequired: challenge,
      binding,
      wallet,
      purchaseRef: "op-retry",
      rpcUrl: RPC_URL,
      rpc: createDevnetRpc(RETRYING_URL, { maxRetries: 2, maxDelayMs: 1 }),
    });
    expect(wallet.calls).toBe(1);
    expect(prepared.validated.amount).toBe(100_000n);
    // The SDK's own client (RPC_URL) made no request: its mint cache was filled.
    expect(urls).toEqual([RETRYING_URL, RETRYING_URL]);
  });

  it("never signs when the challenge violates the binding", async () => {
    stubRpc();
    const cases: Array<[Partial<PaymentRequired["accepts"][number]> | null, Partial<PaymentRequired> | null, string]> = [
      [{ amount: "100001" }, null, "amount_exceeds_ceiling"],
      [{ payTo: (await generateKeyPairSigner()).address }, null, "no_requirement_for_approved_recipient"],
      [{ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, null, "no_devnet_exact_requirement"],
      [{ extra: { feePayer: (await generateKeyPairSigner()).address } }, null, "fee_payer_not_allowed"],
      [{ extra: { feePayer: p.feePayer.address, memo: "acct-123" } }, null, "seller_memo_not_allowed"],
      [null, { resource: { url: "https://evil.example/v1/purchases/q-1/execute" } }, "resource_origin_mismatch"],
      [null, { resource: { url: challenge.resource.url, serviceName: "other", tags: ["veilo-sku:summarize"] } }, "gateway_identity_mismatch"],
      [null, { resource: { url: challenge.resource.url, serviceName: "veilo-gateway-devnet", tags: ["veilo-sku:analyze"] } }, "sku_mismatch"],
    ];
    for (const [acceptOverride, topOverride, reason] of cases) {
      const wallet = countingWallet();
      const accepts = acceptOverride ? [{ ...challenge.accepts[0]!, ...acceptOverride }] : challenge.accepts;
      const pr = { ...challenge, ...(topOverride ?? {}), accepts } as PaymentRequired;
      const error = await preparePayment({ paymentRequired: pr, binding, wallet, purchaseRef: "op", rpcUrl: RPC_URL }).catch(
        (e: unknown) => e,
      );
      expect(error, reason).toBeInstanceOf(X402ClientError);
      expect((error as X402ClientError).reason).toBe(reason);
      expect(wallet.calls).toBe(0);
    }
  });

  it("rejects a binding whose ATA is not derived from payTo", async () => {
    const error = await verifyPaymentRequired(challenge, { ...binding, merchantAta: p.payerAta }).catch((e: unknown) => e);
    expect((error as X402ClientError).reason).toBe("binding_ata_not_derived_from_pay_to");
  });

  it("a single-use wallet refuses a second payment", async () => {
    stubRpc();
    const wallet = keyPairPaymentWallet(p.payer);
    await preparePayment({ paymentRequired: challenge, binding, wallet, purchaseRef: "op-a", rpcUrl: RPC_URL });
    const error = await preparePayment({ paymentRequired: challenge, binding, wallet, purchaseRef: "op-b", rpcUrl: RPC_URL }).catch(
      (e: unknown) => e,
    );
    expect((error as X402ClientError).reason).toBe("payment_wallet_already_used");
  });
});

describe("facilitator capability check", () => {
  const devnetKind = (extra: Record<string, unknown>) => ({ x402Version: 2, scheme: "exact", network: DEVNET_CAIP2, extra }) as SupportedResponse["kinds"][number];
  const base = (kinds: object[]): SupportedResponse => ({ kinds: kinds as SupportedResponse["kinds"], extensions: [], signers: {} });

  it("accepts v2 exact devnet with the pinned fee payer", () => {
    const r = checkFacilitatorSupport(base([devnetKind({ feePayer: "FP1" })]), { network: DEVNET_CAIP2, mint: MINT, feePayer: "FP1" });
    expect(r).toMatchObject({ supported: true, feePayers: ["FP1"], mintEvidence: "unrestricted" });
  });

  it("fails closed without v2 exact devnet support", () => {
    const v1Only = base([{ x402Version: 1, scheme: "exact", network: "solana-devnet", extra: { feePayer: "FP1" } }]);
    expect(checkFacilitatorSupport(v1Only, { network: DEVNET_CAIP2, mint: MINT }).supported).toBe(false);
    const mainnetOnly = base([{ x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: "FP1" } }]);
    expect(checkFacilitatorSupport(mainnetOnly, { network: DEVNET_CAIP2, mint: MINT }).supported).toBe(false);
  });

  it("fails closed on fee payer mismatch, missing fee payer, or a mint list without the pinned mint", () => {
    expect(checkFacilitatorSupport(base([devnetKind({ feePayer: "FP1" })]), { network: DEVNET_CAIP2, mint: MINT, feePayer: "FP2" }).supported).toBe(false);
    expect(checkFacilitatorSupport(base([devnetKind({})]), { network: DEVNET_CAIP2, mint: MINT }).supported).toBe(false);
    expect(checkFacilitatorSupport(base([devnetKind({ feePayer: "FP1", assets: ["Other"] })]), { network: DEVNET_CAIP2, mint: MINT }).supported).toBe(false);
    expect(checkFacilitatorSupport(base([devnetKind({ feePayer: "FP1", assets: [MINT] })]), { network: DEVNET_CAIP2, mint: MINT })).toMatchObject({
      supported: true,
      mintEvidence: "advertised",
    });
  });
});
