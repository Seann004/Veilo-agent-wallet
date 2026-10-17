import { describe, expect, it } from "vitest";
import { WalletFundingProvider } from "../src/integration/funding";

const BINDING = { origin: "http://gw", gatewayIdentity: "g", sku: "research-basic", network: "solana:x", mint: "M", payTo: "P", merchantAta: "A", allowedFeePayers: [] };
const REQ = { purchaseId: "00000000-0000-4000-8000-000000000001", fundingRef: "f", paymentRequired: {}, binding: BINDING, exactAmountUsdc: 1n };

function provider(status: number, body: unknown) {
  return new WalletFundingProvider({
    baseUrl: "http://wallet.test",
    serviceToken: "t",
    fetch: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  });
}

describe("wallet merchant-signing replies (T12)", () => {
  it("passes through the wallet's own not_ready, signed and recovery_required results", async () => {
    expect(await provider(200, { status: "not_ready", reason: "nothing signed" }).signMerchantPayment(REQ)).toEqual({ status: "not_ready", reason: "nothing signed" });
    expect((await provider(200, { status: "signed", paymentSignatureHeader: "h", payer: "1".repeat(32), messageHash: "m" }).signMerchantPayment(REQ)).status).toBe("signed");
    expect((await provider(200, { status: "recovery_required", reason: "r" }).signMerchantPayment(REQ)).status).toBe("recovery_required");
  });

  it("maps a 503 NOT_READY error (pre-sign checks) to not_ready", async () => {
    const r = await provider(503, { error: { code: "NOT_READY", message: "control unreachable (TimeoutError)" } }).signMerchantPayment(REQ);
    expect(r).toEqual({ status: "not_ready", reason: "wallet not ready to sign: control unreachable (TimeoutError)" });
  });

  it("keeps any other error reply with reconciliation and names its code", async () => {
    const r = await provider(500, { error: { code: "INTERNAL_ERROR", message: "internal error" } }).signMerchantPayment(REQ);
    expect(r).toEqual({ status: "recovery_required", reason: "wallet service signing error HTTP 500 INTERNAL_ERROR: internal error" });
    expect((await provider(502, { error: { code: "NOT_READY", message: "x" } }).signMerchantPayment(REQ)).status).toBe("recovery_required");
  });
});
