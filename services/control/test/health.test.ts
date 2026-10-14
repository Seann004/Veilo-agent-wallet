import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DEMO_TOKEN_MINT, DEVNET_GENESIS_HASH, createServiceHealth, loadConfig } from "@veilo/contracts";
import { createApp } from "../src/app";

const config = loadConfig({
  DEVNET_RPC_URL: "https://rpc.test.invalid",
  EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH,
  DEMO_TOKEN_MINT,
  FACILITATOR_URL: "https://facilitator.payai.network",
});

async function getHealth(requiresChain: boolean) {
  const health = createServiceHealth("control", config, requiresChain);
  const server = createApp(health).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("control /health", () => {
  it("reports ok when chain verification is not required", async () => {
    const { status, body } = await getHealth(false);
    expect(status).toBe(200);
    expect(body).toMatchObject({ service: "control", status: "ok", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });
  });

  it("reports unavailable until chain identity is verified", async () => {
    const { status, body } = await getHealth(true);
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: "unavailable", chain: { state: "pending" } });
  });
});
