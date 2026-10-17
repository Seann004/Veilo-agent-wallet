import { z } from "zod";
import { baseUnitString } from "./amounts";

export const POLICY_TIERS = ["observe", "bounded_automatic", "approval_required", "stopped"] as const;
export type PolicyTier = (typeof POLICY_TIERS)[number];

export const AGENT_ROLES = ["credit_manager", "research", "content"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_STATUSES = ["draft", "active", "paused", "revoked", "archived"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** private_x402: pool-funded fresh wallet pays USDC. prepaid_credits: consumes shared gateway credits. */
export const PAYMENT_PATHS = ["private_x402", "prepaid_credits"] as const;
export type PaymentPath = (typeof PAYMENT_PATHS)[number];

const isoTimestamp = z.iso.datetime({ offset: false });
const skuName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const creditManagerConfigSchema = z
  .object({
    creditLowWatermark: baseUnitString,
    creditPackUnits: baseUnitString,
    pollSeconds: z.number().int().min(10).max(86_400),
    cooldownSeconds: z.number().int().min(0).max(86_400),
  })
  .strict();

export const agentPolicyInputSchema = z
  .object({
    tier: z.enum(POLICY_TIERS),
    lifetimeTestUsdc: baseUnitString,
    rolling24hTestUsdc: baseUnitString,
    maxPurchaseTestUsdc: baseUnitString,
    /** Default per-task USDC budget for tasks this agent runs. */
    taskLimitTestUsdc: baseUnitString,
    /** Lifetime gateway usage allowance across all tasks, in microcredits. */
    usageAllowanceUnits: baseUnitString,
    /** Default per-task gateway usage cap, in microcredits. */
    taskCreditUnits: baseUnitString,
    /** With tier approval_required, purchases at or above this exposure need owner approval; absent means all. */
    approvalThresholdTestUsdc: baseUnitString.optional(),
    allowedSkus: z.array(skuName).max(32),
    allowedPaymentPaths: z.array(z.enum(PAYMENT_PATHS)).max(PAYMENT_PATHS.length),
    roleConfig: creditManagerConfigSchema.optional(),
    expiresAt: isoTimestamp.optional(),
  })
  .strict();
export type AgentPolicyInput = z.infer<typeof agentPolicyInputSchema>;

export const workspacePolicyInputSchema = z
  .object({
    tier: z.enum(POLICY_TIERS),
    lifetimeTestUsdc: baseUnitString,
    rolling24hTestUsdc: baseUnitString,
    sponsorLamportLimit: baseUnitString,
    expiresAt: isoTimestamp.optional(),
  })
  .strict();
export type WorkspacePolicyInput = z.infer<typeof workspacePolicyInputSchema>;

export interface SeedAgentDefinition {
  name: string;
  role: AgentRole;
  description: string;
  trigger: Record<string, unknown>;
  policy: AgentPolicyInput;
}

/**
 * Proposed activation defaults in base units. Seeded as drafts; nothing is spendable until
 * the owner activates each policy. Usage allowances and task limits are seed choices.
 */
export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicyInput = {
  tier: "bounded_automatic",
  lifetimeTestUsdc: "10000000",
  rolling24hTestUsdc: "5000000",
  sponsorLamportLimit: "100000000",
};

export const DEFAULT_AGENTS: readonly SeedAgentDefinition[] = [
  {
    name: "Shawn",
    role: "credit_manager",
    description: "Inference-credit manager",
    trigger: { type: "low_credit_balance", pollSeconds: 60 },
    policy: {
      tier: "bounded_automatic",
      lifetimeTestUsdc: "3000000",
      rolling24hTestUsdc: "3000000",
      maxPurchaseTestUsdc: "1000000",
      taskLimitTestUsdc: "1000000",
      usageAllowanceUnits: "0",
      taskCreditUnits: "0",
      allowedSkus: ["inference-credit-pack"],
      allowedPaymentPaths: ["private_x402"],
      roleConfig: { creditLowWatermark: "200000", creditPackUnits: "1000000", pollSeconds: 60, cooldownSeconds: 600 },
    },
  },
  {
    name: "Prince",
    role: "research",
    description: "Research agent",
    trigger: { type: "owner_task" },
    policy: {
      tier: "bounded_automatic",
      lifetimeTestUsdc: "2000000",
      rolling24hTestUsdc: "2000000",
      maxPurchaseTestUsdc: "500000",
      taskLimitTestUsdc: "1000000",
      usageAllowanceUnits: "2000000",
      taskCreditUnits: "400000",
      allowedSkus: ["research-basic", "research-expanded", "summarize", "analyze"],
      allowedPaymentPaths: ["private_x402", "prepaid_credits"],
    },
  },
  {
    name: "Mira",
    role: "content",
    description: "Content manager",
    trigger: { type: "owner_task" },
    policy: {
      tier: "bounded_automatic",
      lifetimeTestUsdc: "2000000",
      rolling24hTestUsdc: "2000000",
      maxPurchaseTestUsdc: "500000",
      taskLimitTestUsdc: "1000000",
      usageAllowanceUnits: "2000000",
      taskCreditUnits: "400000",
      allowedSkus: ["content-package", "summarize", "analyze"],
      allowedPaymentPaths: ["private_x402", "prepaid_credits"],
    },
  },
];

export interface SeedSku {
  sku: string;
  paymentPath: PaymentPath;
  /** USDC base units for private_x402; zero for prepaid_credits. */
  priceUsdc: string;
  maxFeeUsdc: string;
  /** Gateway microcredits for prepaid_credits; zero for private_x402. */
  usageUnits: string;
  sponsorLamports: string;
}

export interface SeedService {
  key: string;
  origin: string;
  description: string;
  skus: SeedSku[];
}

// Sponsor reservation per private purchase covers fresh-wallet ATA rent plus transaction fees.
const SPONSOR_PER_PRIVATE_PURCHASE = "2100000";

const privateSku = (sku: string, price: string): SeedSku => ({
  sku,
  paymentPath: "private_x402",
  priceUsdc: price,
  maxFeeUsdc: "0",
  usageUnits: "0",
  sponsorLamports: SPONSOR_PER_PRIVATE_PURCHASE,
});
const prepaidSku = (sku: string, units: string): SeedSku => ({
  sku,
  paymentPath: "prepaid_credits",
  priceUsdc: "0",
  maxFeeUsdc: "0",
  usageUnits: units,
  sponsorLamports: "0",
});

/** Fixed demo catalog. Recipient bindings are unset until the gateway is configured. */
export const DEFAULT_SERVICES: readonly SeedService[] = [
  {
    key: "veilo-gateway",
    origin: "http://127.0.0.1:4104",
    description: "Veilo Service Gateway (inference, credit packs, content)",
    skus: [
      privateSku("inference-credit-pack", "1000000"),
      privateSku("summarize", "100000"),
      prepaidSku("summarize", "100000"),
      privateSku("analyze", "200000"),
      prepaidSku("analyze", "200000"),
      privateSku("content-package", "300000"),
      prepaidSku("content-package", "300000"),
    ],
  },
  {
    key: "veilo-research-data",
    origin: "http://127.0.0.1:4104",
    description: "Licensed demo research fixtures (labeled demo data)",
    skus: [privateSku("research-basic", "100000"), privateSku("research-expanded", "200000")],
  },
];
