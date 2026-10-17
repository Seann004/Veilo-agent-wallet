import type { Agent, Balances, ContentItem, Purchase, Workspace } from "../lib/types";

export const SHAWN = "11111111-1111-4111-8111-111111111111";
export const PRINCE = "22222222-2222-4222-8222-222222222222";
export const MIRA = "33333333-3333-4333-8333-333333333333";
export const SERVICE = "44444444-4444-4444-8444-444444444444";

const policy = (agentId: string, extra: Partial<Agent["activePolicy"]> = {}) => ({
  id: `p-${agentId}`,
  scope: "agent" as const,
  agentId,
  version: 1,
  status: "active",
  tier: "bounded_automatic",
  lifetimeTestUsdc: "2000000",
  rolling24hTestUsdc: "2000000",
  maxPurchaseTestUsdc: "500000",
  taskLimitTestUsdc: "1000000",
  sponsorLamportLimit: null,
  usageAllowanceUnits: "2000000",
  taskCreditUnits: "400000",
  approvalThresholdTestUsdc: null,
  permissions: { allowedSkus: ["summarize"], allowedPaymentPaths: ["private_x402", "prepaid_credits"] },
  roleConfig: {},
  expiresAtMs: null,
  createdBy: "owner",
  ...extra,
});

export function agent(id: string, name: string, role: Agent["role"], status: Agent["status"] = "active"): Agent {
  return {
    id,
    name,
    role,
    status,
    description: `${name} job`,
    trigger: role === "credit_manager" ? { type: "low_credit_balance", pollSeconds: 60 } : { type: "owner_task" },
    modelProfile: null,
    policyVersion: 1,
    activePolicy: policy(id),
    revocationEpoch: 0,
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
}

export function workspace(overrides: { stopped?: boolean; agents?: Agent[] } = {}): Workspace {
  return {
    workspace: {
      id: "55555555-5555-4555-8555-555555555555",
      ownerPubkey: "Owner1111111111111111111111111111111111111",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      mintDecimals: 6,
      policyVersion: 1,
      emergencyStopEpoch: 0,
      stopped: overrides.stopped ?? false,
      timezone: "Asia/Kuala_Lumpur",
    },
    agents: overrides.agents ?? [agent(SHAWN, "Shawn", "credit_manager"), agent(PRINCE, "Prince", "research"), agent(MIRA, "Mira", "content")],
    policies: [
      {
        ...policy("ws"),
        scope: "workspace",
        agentId: null,
        lifetimeTestUsdc: "10000000",
        rolling24hTestUsdc: "5000000",
        sponsorLamportLimit: "100000000",
      },
    ],
    services: [
      {
        id: SERVICE,
        service_key: "veilo-gateway",
        origin: "http://127.0.0.1:4104",
        gateway_identity: "veilo-gateway-devnet",
        recipient: "Merchant11111111111111111111111111111111111",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        status: "approved",
        skus: [{ sku: "summarize", paymentPath: "prepaid_credits", priceUsdc: "0", maxFeeUsdc: "0", usageUnits: "100000", enabled: true }],
      },
    ],
  };
}

export function purchase(overrides: Omit<Partial<Purchase>, "states"> & { states?: Partial<Purchase["states"]> } = {}): Purchase {
  const { states, ...rest } = overrides;
  return {
    id: "66666666-6666-4666-8666-666666666666",
    operationId: "op-1",
    agentId: SHAWN,
    taskId: null,
    serviceId: SERVICE,
    sku: "inference-credit-pack",
    paymentPath: "private_x402",
    price: { amount: "1000000" },
    feeCap: { amount: "0" },
    sponsorReservation: { amount: "2100000" },
    usage: { amount: "0" },
    states: { authorization: "released", funding: "finalized", merchant: "finalized", fulfilment: "delivered", recovery: "none", ...states },
    label: "Delivered",
    stateReason: null,
    reservation: { status: "settled", closeReason: "settled", usdc: "1000000", lamports: "2100000", usageUnits: "0" },
    policyVersions: { workspace: 1, agent: 1 },
    chainAttempts: [
      { leg: "funding", attempt: 1, signature: "FundSig1111111111111111111111111111111111111111111111111111111111", commitment: "finalized" },
      { leg: "merchant", attempt: 1, signature: "MerchSig111111111111111111111111111111111111111111111111111111111", commitment: "finalized" },
    ],
    rationale: "Credits below threshold",
    settledAt: "2026-10-15T01:00:00.000Z",
    createdAt: "2026-10-15T00:59:00.000Z",
    updatedAt: "2026-10-15T01:00:00.000Z",
    ...rest,
  };
}

const usage = (limit: string, settled: string, reserved: string) => {
  const used = BigInt(settled) + BigInt(reserved);
  const l = BigInt(limit);
  return { limit, settled, reserved, available: (used >= l ? 0n : l - used).toString(), overCommitted: (used > l ? used - l : 0n).toString() };
};

/** Shawn bought one 1.00 USDC pack; Prince then consumed 300,000 microcredits of it. */
export function balancesAfterTopUpAndConsumption(): Balances {
  return {
    workspace: { policyVersion: 1, tier: "bounded_automatic", stopped: false, lifetime: usage("10000000", "1000000", "0"), rolling24h: usage("5000000", "1000000", "0"), sponsor: usage("100000000", "2100000", "0") },
    agents: [
      { agentId: SHAWN, name: "Shawn", role: "credit_manager", status: "active", maxPurchase: "1000000", lifetime: usage("3000000", "1000000", "0"), rolling24h: usage("3000000", "1000000", "0"), usageAllowance: { ...usage("0", "0", "0"), unit: "gateway_microcredits" } },
      { agentId: PRINCE, name: "Prince", role: "research", status: "active", maxPurchase: "500000", lifetime: usage("2000000", "0", "0"), rolling24h: usage("2000000", "0", "0"), usageAllowance: { ...usage("2000000", "300000", "0"), unit: "gateway_microcredits" } },
      { agentId: MIRA, name: "Mira", role: "content", status: "active", maxPurchase: "500000", lifetime: usage("2000000", "0", "0"), rolling24h: usage("2000000", "0", "0"), usageAllowance: { ...usage("2000000", "0", "0"), unit: "gateway_microcredits" } },
    ],
    tokens: { unit: "usdc_base_units", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", buckets: { approved_unreserved: "4000000", confirmed_change: "0", reserved_input: "0", pending_change: "0", payout_balance: "0", merchant_outflow: "1000000", fee_outflow: "0", external_recovered: "0", consumed: "5000000" } },
    cash: {
      spent: "1000000",
      reserved: "0",
      byAgent: [
        { agentId: SHAWN, name: "Shawn", spent: "1000000", reserved: "0" },
        { agentId: PRINCE, name: "Prince", spent: "0", reserved: "0" },
        { agentId: MIRA, name: "Mira", spent: "0", reserved: "0" },
      ],
      note: "Each USDC purchase is counted once.",
    },
    gatewayCredits: { available: true, label: "Demo inference credits — backed by the operator's OpenRouter account", purchased: "1000000", consumed: "300000", reserved: "0", usable: "700000", asOf: "2026-10-15T01:05:00.000Z", stale: false, note: "" },
    usageByAgent: [
      { agentId: SHAWN, name: "Shawn", consumedUnits: "0", reservedUnits: "0", packsPurchased: 1, packUnitsPurchased: "1000000", packCashSpent: "1000000" },
      { agentId: PRINCE, name: "Prince", consumedUnits: "300000", reservedUnits: "0", packsPurchased: 0, packUnitsPurchased: "0", packCashSpent: "0" },
      { agentId: MIRA, name: "Mira", consumedUnits: "0", reservedUnits: "0", packsPurchased: 0, packUnitsPurchased: "0", packCashSpent: "0" },
    ],
    sponsoredPlanning: { label: "operator-sponsored planning", total: 2, note: "", byAgent: [] },
  };
}

export function draft(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    kind: "content_draft",
    title: "LinkedIn post",
    reviewState: "needs_review",
    agent: { id: MIRA, name: "Mira", role: "content" },
    taskId: "88888888-8888-4888-8888-888888888888",
    revision: 1,
    lastAuthor: "agent",
    content: "Original draft text",
    calendar: null,
    citations: [],
    sourcePurchaseIds: [],
    publishing: "none",
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

/** Records fetch calls and answers each with the next queued JSON body. */
export function recordingFetch(respond: (url: string, init: RequestInit | undefined) => unknown = () => ({})) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return new Response(JSON.stringify(respond(url, init)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, impl };
}
