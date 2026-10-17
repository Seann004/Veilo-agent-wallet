import { describe, expect, it } from "vitest";
import {
  AmountError,
  DEFAULT_AGENTS,
  DEFAULT_WORKSPACE_POLICY,
  MAX_LEDGER_AMOUNT,
  RUNNER_WITHHELD_ENV,
  agentPolicyInputSchema,
  baseUnits,
  canTransition,
  checkedAdd,
  checkedMul,
  checkedSub,
  checkedSum,
  loadConfig,
  parseBaseUnits,
  paymentStatusLabel,
  paymentTransitionEdges,
  purchaseIntentRequestSchema,
  toRunnerConfig,
  workspacePolicyInputSchema,
  DEMO_TOKEN_MINT,
  DEVNET_GENESIS_HASH,
} from "../src/index";

describe("decimal-string base units", () => {
  it("accepts canonical non-negative integer strings", () => {
    expect(parseBaseUnits("0")).toBe(0n);
    expect(parseBaseUnits("1000000")).toBe(1_000_000n);
    expect(parseBaseUnits(MAX_LEDGER_AMOUNT.toString())).toBe(MAX_LEDGER_AMOUNT);
    expect(baseUnits.parse("42")).toBe(42n);
  });

  it("rejects numbers, floats, exponents, signs, padding and overflow", () => {
    for (const bad of [1, 1.5, 1e6, "1.5", "1.0", "1e6", "-1", "+1", "01", " 1", "1 ", "", "0x10", "١٢", (MAX_LEDGER_AMOUNT + 1n).toString(), "9".repeat(21), null, undefined, 10n]) {
      expect(() => parseBaseUnits(bad)).toThrow(AmountError);
      expect(baseUnits.safeParse(bad).success).toBe(false);
    }
  });

  it("checked arithmetic throws on overflow and negative results", () => {
    expect(checkedAdd(1n, 2n)).toBe(3n);
    expect(() => checkedAdd(MAX_LEDGER_AMOUNT, 1n)).toThrow(/overflows/);
    expect(() => checkedSub(1n, 2n)).toThrow(/underflows/);
    expect(() => checkedAdd(-1n, 1n)).toThrow(/negative/);
    expect(() => checkedMul(MAX_LEDGER_AMOUNT, 2n)).toThrow(/overflows/);
    expect(checkedSum([1n, 2n, 3n])).toBe(6n);
    expect(() => checkedAdd(1.5 as unknown as bigint, 1n)).toThrow(AmountError);
  });
});

describe("policy schemas", () => {
  it("accepts the default activation policies and rejects numeric amounts", () => {
    expect(workspacePolicyInputSchema.safeParse(DEFAULT_WORKSPACE_POLICY).success).toBe(true);
    for (const a of DEFAULT_AGENTS) expect(agentPolicyInputSchema.safeParse(a.policy).success).toBe(true);
    expect(workspacePolicyInputSchema.safeParse({ ...DEFAULT_WORKSPACE_POLICY, lifetimeTestUsdc: 10_000_000 }).success).toBe(false);
    expect(workspacePolicyInputSchema.safeParse({ ...DEFAULT_WORKSPACE_POLICY, extra: "x" }).success).toBe(false);
    expect(DEFAULT_AGENTS.map((a) => a.name)).toEqual(["Shawn", "Prince", "Mira"]);
  });

  it("purchase intents carry no price or recipient the worker could choose", () => {
    const shape = Object.keys(purchaseIntentRequestSchema.shape);
    for (const forbidden of ["price", "recipient", "amount", "destination", "workspaceId"]) expect(shape).not.toContain(forbidden);
  });
});

describe("payment state transitions", () => {
  it("never moves an uncertain leg to a failure state", () => {
    for (const e of paymentTransitionEdges().filter((x) => x.from === "uncertain")) {
      expect(["abandoned", "rejected"]).not.toContain(e.to);
    }
    expect(canTransition("funding", "uncertain", "abandoned")).toBe(false);
    expect(canTransition("funding", "uncertain", "finalized")).toBe(true);
    expect(canTransition("authorization", "released", "rejected")).toBe(false);
  });

  it("labels uncertain and paid-without-result outcomes honestly", () => {
    const base = { authorization: "released", funding: "finalized", merchant: "uncertain", fulfilment: "not_started", recovery: "none" } as const;
    expect(paymentStatusLabel(base)).toBe("Waiting for confirmation");
    expect(paymentStatusLabel({ ...base, merchant: "finalized", fulfilment: "paid_without_result" })).toBe("Paid; result unavailable");
  });
});

describe("runner configuration", () => {
  it("carries no database, secrets, signer, provider or other-service credential paths", () => {
    const config = loadConfig({
      DEVNET_RPC_URL: "https://rpc.test.invalid",
      EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH,
      DEMO_TOKEN_MINT,
      FACILITATOR_URL: "https://facilitator.payai.network",
      OPENROUTER_API_KEY: "sk-test-provider-key",
      SPONSOR_KEY_PATH: "/keys/sponsor.json",
      OWNER_SERVICE_SECRET_PATH: "/keys/owner.secret",
      WALLET_SERVICE_CREDENTIAL_PATH: "/keys/wallet.cred",
      GATEWAY_ADMIN_CREDENTIAL_PATH: "/keys/gateway.cred",
      RUNNER_WORKER_CREDENTIAL_PATH: "/keys/runner.cred",
    });
    const runner = toRunnerConfig(config);
    const text = JSON.stringify(runner);
    for (const leak of ["sk-test-provider-key", "sponsor", "owner.secret", "wallet.cred", "gateway.cred", "secrets", "sqlite"]) {
      expect(text).not.toContain(leak);
    }
    expect(runner.workerCredentialPath).toMatch(/runner\.cred$/);
    for (const name of [
      "OPENROUTER_API_KEY",
      "SPONSOR_KEY_PATH",
      "FUNDING_KEY_PATH",
      "OWNER_SERVICE_SECRET_PATH",
      "CONTROL_DATABASE_PATH",
      "VEILO_SECRETS_DIR",
      "WALLET_SERVICE_CREDENTIAL_PATH",
      "GATEWAY_ADMIN_CREDENTIAL_PATH",
    ]) {
      expect(RUNNER_WITHHELD_ENV).toContain(name);
    }
  });
});
