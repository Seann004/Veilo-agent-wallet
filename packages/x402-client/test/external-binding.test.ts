import type { PaymentRequired } from "@x402/core/types";
import { DEVNET_CAIP2 } from "@veilo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { resourcePathMatches, verifyPaymentRequired, type ApprovedServiceBinding } from "../src/binding";
import { X402ClientError } from "../src/errors";
import { makeParties, MINT, type Parties } from "./helpers";

const MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ORIGIN = "https://rpc-seller.example";

let p: Parties;
let binding: ApprovedServiceBinding;

/** A challenge shaped like a per-request RPC seller: a top-up and a per-call price on devnet and mainnet. */
function challenge(over: { accepts?: PaymentRequired["accepts"]; url?: string; version?: number } = {}): PaymentRequired {
  const devnet = (amount: string) => ({
    scheme: "exact",
    network: DEVNET_CAIP2,
    amount,
    payTo: p.merchant.address,
    maxTimeoutSeconds: 60,
    asset: MINT,
    extra: { feePayer: p.feePayer.address },
  });
  return {
    x402Version: over.version ?? 2,
    resource: { url: over.url ?? `${ORIGIN}/solana-mainnet`, description: "rpc", mimeType: "application/json" },
    accepts: over.accepts ?? [
      devnet("1000000"),
      devnet("1000"),
      { ...devnet("10000000"), network: MAINNET, asset: MAINNET_USDC },
      { ...devnet("1000"), network: MAINNET, asset: MAINNET_USDC },
    ],
  } as PaymentRequired;
}

async function failure(pr: PaymentRequired, b: ApprovedServiceBinding = binding): Promise<string> {
  const e = await verifyPaymentRequired(pr, b).then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(X402ClientError);
  return (e as X402ClientError).reason;
}

beforeAll(async () => {
  p = await makeParties();
  binding = {
    origin: ORIGIN,
    resourcePath: "/solana-mainnet",
    network: DEVNET_CAIP2,
    mint: MINT,
    payTo: p.merchant.address,
    merchantAta: p.merchantAta,
    maxAmount: 1000n,
    exactAmount: 1000n,
    allowedFeePayers: [p.feePayer.address],
    maxTimeoutSeconds: 120,
  };
});

describe("external x402 binding", () => {
  it("selects the per-request devnet option at the approved exact price", async () => {
    const v = await verifyPaymentRequired(challenge(), binding);
    expect(v.amount).toBe(1000n);
    expect(v.requirements.network).toBe(DEVNET_CAIP2);
    expect(v.feePayer).toBe(p.feePayer.address);
  });

  it("never selects the larger top-up option, and refuses when the approved price is gone", async () => {
    const onlyTopUp = challenge().accepts.filter((r) => r.amount === "1000000" || r.network === MAINNET);
    expect(await failure(challenge({ accepts: onlyTopUp }))).toBe("amount_exceeds_ceiling");
    const raised = challenge().accepts.map((r) => (r.amount === "1000" ? { ...r, amount: "2000" } : r));
    expect(await failure(challenge({ accepts: raised }))).toBe("no_requirement_at_approved_price");
  });

  it("refuses an ambiguous challenge when no exact price is pinned", async () => {
    const loose: ApprovedServiceBinding = { ...binding, maxAmount: 2_000_000n };
    delete loose.exactAmount;
    expect(await failure(challenge(), loose)).toBe("ambiguous_requirements");
  });

  it("refuses mainnet-only challenges and mainnet bindings", async () => {
    const mainnetOnly = challenge().accepts.filter((r) => r.network === MAINNET);
    expect(await failure(challenge({ accepts: mainnetOnly }))).toBe("no_devnet_exact_requirement");
    expect(await failure(challenge(), { ...binding, network: MAINNET })).toBe("binding_network_not_devnet");
    expect(await failure(challenge(), { ...binding, mint: MAINNET_USDC })).toBe("binding_mint_not_pinned");
  });

  it("refuses a different mint, recipient or recipient ATA", async () => {
    const otherMint = challenge().accepts.map((r) => ({ ...r, asset: MAINNET_USDC }));
    expect(await failure(challenge({ accepts: otherMint }))).toBe("no_requirement_for_pinned_mint");
    const otherPayTo = challenge().accepts.map((r) => ({ ...r, payTo: p.payer.address }));
    expect(await failure(challenge({ accepts: otherPayTo }))).toBe("no_requirement_for_approved_recipient");
    expect(await failure(challenge(), { ...binding, merchantAta: p.payerAta })).toBe("binding_ata_not_derived_from_pay_to");
  });

  it("refuses a fee payer outside the allowed list", async () => {
    const otherFeePayer = challenge().accepts.map((r) => ({ ...r, extra: { feePayer: p.payer.address } }));
    expect(await failure(challenge({ accepts: otherFeePayer }))).toBe("fee_payer_not_allowed");
  });

  it("refuses another origin or path", async () => {
    expect(await failure(challenge({ url: "https://evil.example/solana-mainnet" }))).toBe("resource_origin_mismatch");
    expect(await failure(challenge({ url: `${ORIGIN}/base-mainnet` }))).toBe("resource_path_mismatch");
    expect(await failure(challenge({ url: `${ORIGIN}/solana-mainnet/extra` }))).toBe("resource_path_mismatch");
  });

  it("refuses x402 v1, seller memos, long timeouts and unknown payment flows", async () => {
    expect(await failure(challenge({ version: 1 }))).toBe("x402_version_not_2");
    const memo = challenge().accepts.map((r) => ({ ...r, extra: { ...r.extra, memo: "acct-123" } }));
    expect(await failure(challenge({ accepts: memo }))).toBe("seller_memo_not_allowed");
    const slow = challenge().accepts.map((r) => ({ ...r, maxTimeoutSeconds: 3600 }));
    expect(await failure(challenge({ accepts: slow }))).toBe("max_timeout_out_of_bounds");
    const flow = challenge().accepts.map((r) => ({ ...r, extra: { ...r.extra, paymentFlow: "stream" } }));
    expect(await failure(challenge({ accepts: flow }))).toBe("payment_flow_not_allowed");
  });

  it("matches resource paths exactly or by a deeper /* prefix", () => {
    expect(resourcePathMatches("/solana-mainnet", "/solana-mainnet")).toBe(true);
    expect(resourcePathMatches("/solana-mainnet", "/solana-mainnet/")).toBe(false);
    expect(resourcePathMatches("/v1/*", "/v1/search")).toBe(true);
    expect(resourcePathMatches("/v1/*", "/v1/")).toBe(false);
    expect(resourcePathMatches("/v1/*", "/v2/search")).toBe(false);
    expect(resourcePathMatches("/v1/*", "/v1/../admin")).toBe(false);
    expect(resourcePathMatches("v1", "v1")).toBe(false);
    expect(resourcePathMatches("/a?b", "/a")).toBe(false);
    expect(resourcePathMatches("/v1/*", "/v1/%2e%2e/admin")).toBe(false);
    expect(resourcePathMatches("/v1/*", "/v1/./x")).toBe(false);
    expect(resourcePathMatches("/v1/*", "/v1/a\\..\\b")).toBe(false);
    expect(resourcePathMatches("/v1/*", "/v1/x?y=1")).toBe(false);
  });
});
