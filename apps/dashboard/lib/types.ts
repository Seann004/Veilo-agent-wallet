/** Shapes of owner API responses as consumed by the dashboard (amounts are decimal strings). */
export type AgentRole = "credit_manager" | "research" | "content";
export type AgentStatus = "draft" | "active" | "paused" | "revoked" | "archived";

export interface Policy {
  id: string;
  scope: "workspace" | "agent";
  agentId: string | null;
  version: number;
  status: string;
  tier: string;
  lifetimeTestUsdc: string | null;
  rolling24hTestUsdc: string | null;
  maxPurchaseTestUsdc: string | null;
  taskLimitTestUsdc: string | null;
  sponsorLamportLimit: string | null;
  usageAllowanceUnits: string | null;
  taskCreditUnits: string | null;
  approvalThresholdTestUsdc: string | null;
  permissions: { allowedSkus?: string[]; allowedPaymentPaths?: string[] } | null;
  roleConfig: Record<string, unknown> | null;
  expiresAtMs: number | null;
  createdBy: string;
}

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  description: string | null;
  trigger: Record<string, unknown>;
  modelProfile: string | null;
  policyVersion: number;
  activePolicy: Policy | null;
  revocationEpoch: number;
  updatedAt: string;
}

export interface Workspace {
  workspace: {
    id: string;
    ownerPubkey: string;
    network: string;
    mint: string;
    mintDecimals: number;
    policyVersion: number;
    emergencyStopEpoch: number;
    stopped: boolean;
    timezone: string;
  };
  agents: Agent[];
  policies: Policy[];
  services: Array<{
    id: string;
    service_key: string;
    origin: string;
    gateway_identity: string | null;
    recipient: string | null;
    network: string;
    mint: string;
    status: string;
    skus: Array<{ sku: string; paymentPath: string; priceUsdc: string; maxFeeUsdc: string; usageUnits: string; enabled: boolean }>;
  }>;
}

export interface LimitUsage {
  limit: string;
  settled: string;
  reserved: string;
  available: string;
  overCommitted: string;
}

export interface AgentBudget {
  agentId: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  policy?: null;
  policyVersion?: number;
  tier?: string;
  maxPurchase?: string;
  lifetime?: LimitUsage;
  rolling24h?: LimitUsage;
  usageAllowance?: LimitUsage & { unit: string };
}

export type WorkspaceBudget =
  | { policyVersion: number; tier: string; stopped: boolean; lifetime: LimitUsage; rolling24h: LimitUsage; sponsor: LimitUsage }
  | { policyVersion: null; stopped: boolean; note: string };

export type GatewayCredits =
  | { available: true; label: string; purchased: string; consumed: string; reserved: string; usable: string; asOf: string; stale: boolean; note: string }
  | { available: false; code: string; message: string; label?: string };

export interface Balances {
  workspace: WorkspaceBudget;
  agents: AgentBudget[];
  tokens: { unit: string; mint: string; buckets: Record<string, string> };
  cash?: { spent: string; reserved: string; byAgent: Array<{ agentId: string; name: string; spent: string; reserved: string }>; note: string };
  gatewayCredits: GatewayCredits;
  usageByAgent?: Array<{ agentId: string; name: string; consumedUnits: string; reservedUnits: string; packsPurchased: number; packUnitsPurchased: string; packCashSpent: string }>;
  sponsoredPlanning?: { label: string; total: number; note: string; byAgent: Array<{ agentId: string; name: string | null; calls: number; tasks: number }> };
}

export interface PaymentStates {
  authorization: string;
  funding: string;
  merchant: string;
  fulfilment: string;
  recovery: string;
}

export interface Purchase {
  id: string;
  operationId: string;
  agentId: string;
  taskId: string | null;
  serviceId: string;
  sku: string;
  paymentPath: "private_x402" | "prepaid_credits";
  price: { amount: string };
  feeCap: { amount: string };
  sponsorReservation: { amount: string };
  usage: { amount: string };
  states: PaymentStates;
  label: string;
  stateReason: string | null;
  reservation: { status: string; closeReason: string | null; usdc: string; lamports: string; usageUnits: string };
  policyVersions: { workspace: number; agent: number };
  chainAttempts: Array<{ leg: string; attempt: number; signature: string | null; commitment: string }>;
  rationale: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  seq: number;
  scope: string;
  actor: { type: string; id: string | null };
  action: string;
  policyResult: string;
  reasonCode: string | null;
  details: Record<string, unknown>;
  at: string;
}

export interface Activity {
  events: AuditEvent[];
  purchases: Purchase[];
}

export interface Task {
  id: string;
  agentId: string;
  objective: string;
  input: Record<string, unknown>;
  state: string;
  deadline: string | null;
  limits: { taskUsdc: string; taskUsageUnits: string; maxToolCalls: number; maxPaidPurchases: number; maxPlanningCalls: number };
  used: { toolCalls: number; paidPurchases: number; planningCalls: number };
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  agentId: string;
  taskId: string | null;
  kind: string;
  state: string;
  scheduledAt: string;
  attempts: number;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEntry {
  day: number;
  date: string | null;
  channel: string;
  draftArtifactId: string | null;
  action: string;
}

export type ReviewState = "draft" | "needs_review" | "approved_for_export" | "archived";

export interface ContentItem {
  id: string;
  kind: "research_brief" | "content_draft" | "content_calendar";
  title: string;
  reviewState: ReviewState;
  agent: { id: string; name: string; role: string };
  taskId: string;
  revision: number;
  lastAuthor: "agent" | "owner";
  content: string;
  calendar: CalendarEntry[] | null;
  citations: Array<{ url: string; title?: string }>;
  sourcePurchaseIds: string[];
  publishing: string;
  createdAt: string;
  updatedAt: string;
}

export interface Handoff {
  id: string;
  artifactId: string;
  fromAgentId: string;
  toAgentId: string;
  state: string;
  note: string | null;
  taskId: string | null;
  createdAt: string;
}

export interface WalletNote {
  id: string;
  origin: "deposit" | "change";
  depositId: string | null;
  state: string;
  value: { amount: string };
  leafIndex: number | null;
  available: boolean;
  depositStages?: Record<string, boolean>;
  depositTransaction?: string | null;
  refundAuthority: string | null;
}

export interface NoteStatus {
  notes: WalletNote[];
  totals: { spendable: { amount: string }; reserved: { amount: string }; pending: { amount: string } };
  sync?: { synced: boolean; reason?: string };
}

export interface PublicState {
  finalizedSlot: string;
  consistent: boolean;
  pool: { minDeposit: string; maxDeposit: string; depositsPaused: boolean; liability: string };
  deposits: Array<{ amount: string; refundAuthority: string; state: string; label: string }>;
  spends: Array<{ withdrawnValue: string }>;
  exits: Array<{ value: string }>;
  approved: { labels: string[]; version: string; consistent: boolean; rule: string };
}

export interface Health {
  service: string;
  status: "ok" | "unavailable";
  network: string;
  chain:
    | { state: "verified"; identity: { genesisHash: string; caip2: string; mint: string; mintDecimals: number; checkedAt: string } }
    | { state: "pending" | "not_required" }
    | { state: "unavailable"; reason: string };
}
