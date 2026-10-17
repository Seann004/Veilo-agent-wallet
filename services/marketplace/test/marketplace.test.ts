import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { generateKeyPair, getAddressFromPublicKey, getBase58Decoder, signBytes } from "@solana/kit";
import type { User } from "@supabase/supabase-js";
import { CONTROLLER_HEADERS, controllerSigningMessage } from "@veilo/contracts/marketplace";
import type { Request } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { authenticateController, walletAddressOf } from "../src/auth";
import { checkTransfer, type ParsedTransaction } from "../src/chain";
import type { MarketplaceConfig } from "../src/config";
import type { Db } from "../src/db";
import { sellerOriginAllowed } from "../src/service";

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SELLER = "49TED53TmAC4EsScoN3zn6iTHZXAcz6J5w9trmnyAVWX";
const SELLER_ATA = "9YVRYnbzEojUGCNVuW1eGjjzPywAYYWRV92omacRjMuC";
const PAYER = "8djHL1qrsvv6mJJVbfw6i8A1nqeGDw4SQor7YW8tKtcD";
const PAYER_ATA = "4J1qfNt2THkiBvWtpcD4NEoKYJ8v9Z81KtKvLWLY2NHC";

function tx(over: { amount?: string; owner?: string; mint?: string; err?: unknown; extraTransfer?: boolean; inner?: boolean } = {}): ParsedTransaction {
  const transfer = {
    program: "spl-token",
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    parsed: { type: "transferChecked", info: { source: PAYER_ATA, destination: SELLER_ATA, mint: over.mint ?? MINT, authority: PAYER, tokenAmount: { amount: over.amount ?? "250000" } } },
  };
  const outer = over.inner ? [{ programId: "ComputeBudget111111111111111111111111111111" }] : [transfer];
  if (over.extraTransfer) outer.push(transfer);
  return {
    slot: 4242,
    meta: {
      err: over.err ?? null,
      innerInstructions: over.inner ? [{ index: 0, instructions: [transfer] }] : [],
      postTokenBalances: [{ accountIndex: 2, mint: over.mint ?? MINT, owner: over.owner ?? SELLER }],
    },
    transaction: { message: { accountKeys: [PAYER, PAYER_ATA, SELLER_ATA], instructions: outer } },
  };
}

const expected = { signature: "sig", mint: MINT, recipient: SELLER, recipientAta: SELLER_ATA, amount: 250_000n };

describe("receipt verification", () => {
  it("accepts exactly one matching finalized transfer", () => {
    const r = checkTransfer(tx(), expected);
    expect(r).toMatchObject({ status: "verified", transfer: { amount: 250_000n, instructionIndex: 0, slot: 4242n, sourceOwner: PAYER } });
    expect(checkTransfer(tx({ inner: true }), expected)).toMatchObject({ status: "verified", transfer: { instructionIndex: 1000 } });
  });

  it("treats an unknown or unfinalized transaction as pending, never as unpaid", () => {
    expect(checkTransfer(null, expected)).toEqual({ status: "pending" });
  });

  it("rejects mismatches", () => {
    expect(checkTransfer(tx({ amount: "249999" }), expected).status).toBe("invalid");
    expect(checkTransfer(tx({ amount: "250001" }), expected).status).toBe("invalid");
    expect(checkTransfer(tx({ owner: PAYER }), expected).status).toBe("invalid");
    expect(checkTransfer(tx({ mint: "So11111111111111111111111111111111111111112" }), expected).status).toBe("invalid");
    expect(checkTransfer(tx({ err: { InstructionError: [0, "Custom"] } }), expected).status).toBe("invalid");
    expect(checkTransfer(tx({ extraTransfer: true }), expected).status).toBe("invalid");
  });

  it("binds the transfer to the operation's payer", () => {
    expect(checkTransfer(tx(), { ...expected, sourceOwner: PAYER }).status).toBe("verified");
    expect(checkTransfer(tx(), { ...expected, sourceOwner: SELLER }).status).toBe("invalid");
  });
});

describe("wallet identity", () => {
  it("reads only the web3 identity, never editable metadata", () => {
    const user = (identities: unknown[], meta: Record<string, unknown> = {}) => ({ id: "u", identities, user_metadata: meta }) as unknown as User;
    expect(walletAddressOf(user([{ provider: "web3", id: `web3:solana:${SELLER}`, identity_data: { sub: `web3:solana:${SELLER}` } }]))).toBe(SELLER);
    expect(walletAddressOf(user([], { address: SELLER }))).toBeNull();
    expect(walletAddressOf(user([{ provider: "email", id: "x", identity_data: { address: SELLER } }]))).toBeNull();
    expect(walletAddressOf(user([{ provider: "web3", id: "web3:ethereum:0xabc", identity_data: { sub: "web3:ethereum:0xabc" } }]))).toBeNull();
  });
});

describe("controller request signatures", () => {
  async function signed(over: { body?: string; path?: string; timestamp?: string; nonce?: string } = {}) {
    const keys = await generateKeyPair();
    const address = await getAddressFromPublicKey(keys.publicKey);
    const body = over.body ?? JSON.stringify({ decision: "accepted", code: null, controllerRef: "c1" });
    const timestamp = over.timestamp ?? new Date().toISOString();
    const nonce = over.nonce ?? "nonce_0123456789abcdef";
    const keyId = "ctl_testkey01";
    const message = controllerSigningMessage({ method: "POST", path: "/controller/payment-requests/op/decision", bodyDigest: createHash("sha256").update(body).digest("hex"), timestamp, nonce, keyId });
    const sig = getBase58Decoder().decode(await signBytes(keys.privateKey, new TextEncoder().encode(message)));
    const headers: Record<string, string> = {
      [CONTROLLER_HEADERS.keyId]: keyId,
      [CONTROLLER_HEADERS.timestamp]: timestamp,
      [CONTROLLER_HEADERS.nonce]: nonce,
      [CONTROLLER_HEADERS.signature]: sig,
    };
    const req = (rawBody: string, path = over.path ?? "/controller/payment-requests/op/decision") =>
      ({ method: "POST", originalUrl: path, rawBody: Buffer.from(rawBody), header: (n: string) => headers[n.toLowerCase()] }) as unknown as Request & { rawBody: Buffer };
    return { address, body, req };
  }

  it("accepts a valid request once and refuses its replay", async () => {
    const s = await signed();
    const seen = new Set<string>();
    const consume = async (k: string, n: string) => (seen.has(k + n) ? false : (seen.add(k + n), true));
    const lookup = async () => ({ workspaceId: "ws1", controllerKey: s.address });
    await expect(authenticateController(s.req(s.body), lookup, consume)).resolves.toEqual({ workspaceId: "ws1", keyId: "ctl_testkey01" });
    await expect(authenticateController(s.req(s.body), lookup, consume)).rejects.toThrow(/nonce already used/);
  });

  it("refuses a tampered body, another path, a stale timestamp or another key", async () => {
    const s = await signed();
    const lookup = async () => ({ workspaceId: "ws1", controllerKey: s.address });
    const consume = async () => true;
    await expect(authenticateController(s.req(s.body.replace("accepted", "rejected")), lookup, consume)).rejects.toThrow(/signature invalid/);
    await expect(authenticateController(s.req(s.body, "/controller/hires"), lookup, consume)).rejects.toThrow(/signature invalid/);
    const stale = await signed({ timestamp: new Date(Date.now() - 5 * 60_000).toISOString() });
    await expect(authenticateController(stale.req(stale.body), async () => ({ workspaceId: "w", controllerKey: stale.address }), consume)).rejects.toThrow(/timestamp/);
    await expect(authenticateController(s.req(s.body), async () => ({ workspaceId: "ws1", controllerKey: SELLER }), consume)).rejects.toThrow(/signature invalid/);
    await expect(authenticateController(s.req(s.body), async () => null, consume)).rejects.toThrow(/unknown controller key/);
  });

  it("does not burn a nonce for a forged request", async () => {
    const s = await signed();
    let consumed = 0;
    await expect(
      authenticateController(s.req("{}"), async () => ({ workspaceId: "w", controllerKey: s.address }), async () => {
        consumed += 1;
        return true;
      }),
    ).rejects.toThrow();
    expect(consumed).toBe(0);
  });
});

const config: MarketplaceConfig = {
  port: 0,
  bindHost: "127.0.0.1",
  supabaseUrl: "http://unused",
  supabaseSecretKey: "unused",
  supabasePublishableKey: "unused",
  rpcUrl: "http://unused",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mint: MINT,
  decimals: 6,
  sellerHostTokenHash: createHash("sha256").update("managed-host-token-0123456789").digest("hex"),
  operatorTokenHash: createHash("sha256").update("operator-token-0123456789").digest("hex"),
  managedSellerOrigin: "http://127.0.0.1:4107",
  managedSellerIdentity: "veilo-seller-host-devnet",
  devSellerOrigins: ["http://127.0.0.1:6150"],
  allowedBrowserOrigins: ["http://localhost:3000"],
  maxNetworkFeeLamports: 10_000_000n,
  quoteTtlSeconds: 300,
  termsVersion: "2026-10-17",
};

describe("seller origin policy", () => {
  it("admits public https origins and only allowlisted local ones", () => {
    expect(sellerOriginAllowed(config, "https://seller.example.com")).toBe(true);
    expect(sellerOriginAllowed(config, "http://127.0.0.1:6150")).toBe(true);
    expect(sellerOriginAllowed(config, "http://127.0.0.1:6151")).toBe(false);
    expect(sellerOriginAllowed(config, "http://169.254.169.254")).toBe(false);
  });
});

describe("HTTP authentication happens before any data access", () => {
  let base = "";
  let close: () => void = () => {};
  const touched: string[] = [];
  beforeAll(async () => {
    const trap = new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        touched.push(String(prop));
        throw new Error(`database touched: ${String(prop)}`);
      },
    });
    const db = { admin: trap, asUser: () => trap, anon: () => trap, getUser: async () => null, rpc: async () => { touched.push("rpc"); throw new Error("rpc"); } } as unknown as Db;
    const chain = { genesisHash: async () => config.genesisHash, finalizedSlot: async () => 1n, finalizedTransaction: async () => null, tokenAccount: async () => null };
    const server = createApp({ db, chain, config, now: () => new Date() }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  it.each([
    ["POST", "/jobs"],
    ["GET", "/jobs"],
    ["POST", "/jobs/7d1b7a4e-2f0c-4a7e-9c1e-1a2b3c4d5e6f/approve"],
    ["POST", "/artifacts/7d1b7a4e-2f0c-4a7e-9c1e-1a2b3c4d5e6f/download"],
    ["POST", "/seller/payouts"],
    ["GET", "/seller/dashboard"],
    ["POST", "/me/controller"],
    ["GET", "/controller/payment-requests"],
    ["POST", "/controller/hires"],
    ["GET", "/operator/review-queue"],
    ["GET", "/internal/seller-host/jobs/7d1b7a4e-2f0c-4a7e-9c1e-1a2b3c4d5e6f"],
  ])("%s %s without credentials is 401", async (method, path) => {
    touched.length = 0;
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    expect(res.status).toBe(401);
    expect(touched).toEqual([]);
  });

  it("rejects a wrong operator token and an expired user session", async () => {
    let res = await fetch(`${base}/operator/review-queue`, { headers: { authorization: "Bearer wrong-operator-token-xyz" } });
    expect(res.status).toBe(401);
    res = await fetch(`${base}/jobs`, { headers: { authorization: "Bearer some-expired-access-token" } });
    expect(res.status).toBe(401);
  });

  it("does not grant CORS to an unknown origin", async () => {
    const res = await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await fetch(`${base}/health`, { headers: { origin: "http://localhost:3000" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });
});
