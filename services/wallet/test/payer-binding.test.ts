import { createHash, createPublicKey, verify } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { address, getAddressEncoder, getBase58Encoder } from "@solana/kit";
import { createServiceHealth, DEMO_TOKEN_MINT, DEVNET_GENESIS_HASH, loadConfig } from "@veilo/contracts";
import { payerBindingMessage } from "@veilo/contracts/marketplace";
import { advanceAuthority } from "@veilo/control/src/ledger/purchases";
import { createApp } from "../src/app";
import { authorize, createWorld, depositAndApprove, fundingInput, type TestWallet, type World } from "./harness";

const CONTROL_TOKEN = `control-service-token-${"z".repeat(32)}`;
const config = loadConfig({ DEVNET_RPC_URL: "https://rpc.test.invalid", EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH, DEMO_TOKEN_MINT, FACILITATOR_URL: "https://facilitator.payai.network" });
const DIGEST = "d".repeat(64);

let world: World;
let w: TestWallet;
let base: string;
let close: () => void;

beforeEach(async () => {
  world = await createWorld();
  w = world.open();
  const app = createApp(createServiceHealth("wallet", config, false), {
    funding: w.funding,
    notes: w.notes,
    owner: w.owner,
    control: w.deps.control,
    controlCredentialDigest: createHash("sha256").update(CONTROL_TOKEN).digest("hex"),
    dashboardOrigin: "http://localhost:3000",
    isReady: () => true,
    log: () => undefined,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterEach(() => {
  close();
  world.cleanup();
});

const post = async (path: string, body: unknown, token: string | null = CONTROL_TOKEN) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
};

const verifies = (payer: string, message: string | Uint8Array, proof: string) =>
  verify(
    null,
    typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message),
    createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(getAddressEncoder().encode(address(payer))).toString("base64url") }, format: "jwk" }),
    Buffer.from(getBase58Encoder().encode(proof)),
  );

async function prepared(key: string): Promise<{ id: string; payer: string }> {
  const p = authorize(world, key);
  advanceAuthority(world.control.env.ledger, p.id, "prepare_proof");
  const r = await w.funding.prepare(fundingInput(world, p.id));
  expect(r.status).toBe("prepared");
  return { id: p.id, payer: (r as { payer: string }).payer };
}

describe("payer binding signature", () => {
  it("signs only the domain-separated binding message for the attempt's own payer", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    await depositAndApprove(world, w, 1_000_000n);
    const { id, payer } = await prepared("bind1");
    const path = `/fundings/${id}/payer-binding`;
    expect((await post(path, { fundingRef: id, operationId: "op_1", quoteDigest: DIGEST }, null)).status).toBe(401);
    const r = await post(path, { fundingRef: id, operationId: "op_1", quoteDigest: DIGEST });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "signed", payer });
    expect(verifies(payer, payerBindingMessage("op_1", DIGEST, payer), r.body.proof as string)).toBe(true);
    // The proof is useless for another payer, another operation, raw text or transaction bytes.
    const other = (await prepared("bind2")).payer;
    expect(verifies(payer, payerBindingMessage("op_1", DIGEST, other), r.body.proof as string)).toBe(false);
    expect(verifies(payer, payerBindingMessage("op_2", DIGEST, payer), r.body.proof as string)).toBe(false);
    expect(verifies(payer, "op_1", r.body.proof as string)).toBe(false);
    expect(verifies(payer, new Uint8Array([1, 0, 1, 3, 0, 0, 0]), r.body.proof as string)).toBe(false);
    // No caller-supplied bytes, payer or message are accepted.
    for (const extra of [{ payer: other }, { message: "transfer everything" }, { messageBytes: "AQABAw==" }]) {
      expect((await post(path, { fundingRef: id, operationId: "op_1", quoteDigest: DIGEST, ...extra })).status).toBe(400);
    }
    expect((await post(path, { fundingRef: id, operationId: "op 1\nfake", quoteDigest: DIGEST })).status).toBe(400);
    expect((await post(path, { fundingRef: id, operationId: "op_1", quoteDigest: "not-a-digest" })).status).toBe(400);
    // The fundingRef must name this purchase's own attempt.
    expect((await post(path, { fundingRef: "other", operationId: "op_1", quoteDigest: DIGEST })).body).toMatchObject({ status: "refused" });
  });

  it("refuses once the attempt has been released", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const { id } = await prepared("bind3");
    advanceAuthority(world.control.env.ledger, id, "release_proof");
    await w.funding.release(id, id);
    const r = await post(`/fundings/${id}/payer-binding`, { fundingRef: id, operationId: "op_3", quoteDigest: DIGEST });
    expect(r.body).toMatchObject({ status: "refused" });
    expect(r.body.proof).toBeUndefined();
  });

  it("refuses a purchase with no funding attempt", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const p = authorize(world, "bind4");
    const r = await post(`/fundings/${p.id}/payer-binding`, { fundingRef: p.id, operationId: "op_4", quoteDigest: DIGEST });
    expect(r.body).toMatchObject({ status: "refused" });
  });
});
