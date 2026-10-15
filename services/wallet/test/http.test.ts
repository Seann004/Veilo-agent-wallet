import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServiceHealth, DEMO_TOKEN_MINT, DEVNET_GENESIS_HASH, loadConfig } from "@veilo/contracts";
import { advanceAuthority } from "@veilo/control/src/ledger/purchases";
import { createApp } from "../src/app";
import { authorize, createWorld, depositAndApprove, fundingInput, type TestWallet, type World } from "./harness";

const CONTROL_TOKEN = `control-service-token-${"y".repeat(32)}`;
const config = loadConfig({ DEVNET_RPC_URL: "https://rpc.test.invalid", EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH, DEMO_TOKEN_MINT, FACILITATOR_URL: "https://facilitator.payai.network" });

let world: World;
let w: TestWallet;
let base: string;
let ready = false;
let logs: string[];
let close: () => void;

beforeEach(async () => {
  world = await createWorld();
  w = world.open();
  logs = [];
  ready = false;
  const app = createApp(createServiceHealth("wallet", config, false), {
    funding: w.funding,
    notes: w.notes,
    owner: w.owner,
    control: w.deps.control,
    controlCredentialDigest: createHash("sha256").update(CONTROL_TOKEN).digest("hex"),
    dashboardOrigin: "http://localhost:3000",
    isReady: () => ready,
    log: (l) => logs.push(l),
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

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

describe("wallet HTTP boundary", () => {
  it("serves the FundingProvider routes only to control's credential and only after startup reconciliation", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const p = authorize(world, "http1");
    advanceAuthority(world.control.env.ledger, p.id, "prepare_proof");
    const f = fundingInput(world, p.id);
    const body = { ...f, payoutUsdc: f.payoutUsdc.toString(), tokenFeeCapUsdc: f.tokenFeeCapUsdc.toString(), sponsorLamportCap: f.sponsorLamportCap.toString(), inputNote: { commitment: f.inputNote.commitment, value: f.inputNote.value.toString() } };
    expect((await post("/fundings", body)).status).toBe(401);
    expect((await post("/fundings", body, "wrong-token-".padEnd(40, "z"))).status).toBe(401);
    const notReady = await post("/fundings", body, CONTROL_TOKEN);
    expect(notReady.status).toBe(503);
    ready = true;
    const ok = await post("/fundings", body, CONTROL_TOKEN);
    expect(await ok.json()).toMatchObject({ status: "prepared", fundingRef: p.id });
    const st = await fetch(`${base}/fundings/${p.id}`, { headers: { authorization: `Bearer ${CONTROL_TOKEN}` } });
    expect(await st.json()).toMatchObject({ status: "prepared" });
    // Unknown fields (e.g. a secret) are rejected by the strict schema.
    expect((await post("/fundings", { ...body, noteSecret: "1" }, CONTROL_TOKEN)).status).toBe(400);
    for (const l of logs) expect(l).not.toMatch(/Bearer|commitment|payout|token/i);
  });

  it("requires an owner session for owner routes and never accepts a recovery destination", async () => {
    expect((await post("/deposits/prepare", { amount: "100000" })).status).toBe(401);
    expect((await fetch(`${base}/notes/status`)).status).toBe(401);
    const bad = await fetch(`${base}/notes/status`, { headers: { cookie: "veilo_session=vos_invalid" } });
    expect(bad.status).toBe(401);
    expect((await post("/recovery/prepare", { purchaseId: "00000000-0000-0000-0000-000000000001", destination: "x" })).status).toBe(401);
  });
});
