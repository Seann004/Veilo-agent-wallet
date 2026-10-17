/**
 * Marketplace API shapes as the dashboard reads them. Rows come straight from PostgREST, so
 * amounts may arrive as strings or JSON numbers and are normalized with toBaseUnits before use.
 */
export type Amount = string | number | null;

export interface CatalogEntry {
  listing_id: string;
  listing_version_id: string;
  slug: string;
  seller_name: string;
  title: string;
  summary: string;
  description: string;
  runtime_kind: string;
  template: string | null;
  price_base_units: Amount;
  fee_bps: number;
  network: string;
  mint: string;
  decimals: number;
  recipient: string;
  turnaround_minutes: number;
  refund_terms: string;
  data_handling: string;
  input_hint: string;
  output_format: string;
  published_at: string;
}

export interface ListingSample {
  id: string;
  title: string;
  content: string;
}

export interface MarketHealth {
  service: string;
  network: string;
  mint: string;
  managedSellerHost: boolean;
  label: string;
}

export interface QuoteFields {
  id: string;
  operationId: string;
  buyerWorkspaceId: string;
  jobId: string;
  listingVersionId: string;
  runtimeVersion: string;
  inputDigest: string;
  network: string;
  genesisHash: string;
  mint: string;
  decimals: number;
  recipient: string;
  recipientAta: string;
  sellerOrigin: string;
  sellerIdentity: string;
  baseUnits: string;
  feeBps: number;
  feeUnits: string;
  totalUnits: string;
  maxNetworkFeeLamports: string;
  termsVersion: string;
  expiresAt: string;
  quoteDigest: string;
}

export interface HireResponse {
  jobId: string;
  existing: boolean;
  quote: QuoteFields;
}

export interface JobRow {
  id: string;
  buyer_workspace_id?: string;
  seller_id?: string;
  listing_version_id: string;
  requesting_agent_id?: string | null;
  operation_id?: string;
  state: string;
  financial_state: string;
  input_deadline?: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuoteRow {
  id: string;
  job_id: string;
  fields: QuoteFields;
  quote_digest: string;
  base_units: Amount;
  fee_units: Amount;
  total_units: Amount;
  recipient: string;
  recipient_ata: string;
  network: string;
  mint: string;
  expires_at: string;
  retired_at: string | null;
}

export interface JobInput {
  id: string;
  kind: "brief" | "question" | "response" | "attachment" | string;
  body: string;
  created_by: string;
  created_at: string;
}

export interface JobEvent {
  seq: number;
  kind: string;
  from_state: string | null;
  to_state: string | null;
  actor_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface ArtifactRow {
  id: string;
  sha256: string;
  mime_type: string;
  bytes: number;
  validation_state: string;
  version: number;
  created_at: string;
}

export interface ReceiptRow {
  signature: string;
  amount: Amount;
  mint: string;
  network: string;
  finalized_slot: number | string;
  verified_at: string;
}

export interface RefundRow {
  id: string;
  job_id?: string;
  amount: Amount;
  status: "requested" | "declined" | "approved" | "submitted" | "uncertain" | "finalized" | string;
  reason: string;
  return_address?: string;
  refund_signature: string | null;
  created_at: string;
}

export interface PaymentRow {
  status: string;
  reject_code: string | null;
  updated_at: string;
}

export interface JobDetail {
  job: JobRow;
  quote: QuoteRow | null;
  inputs: JobInput[];
  events: JobEvent[];
  artifacts: ArtifactRow[];
  receipt: ReceiptRow | null;
  refunds: RefundRow[];
  payment: PaymentRow | null;
  label: string;
}

export interface MeResponse {
  userId: string;
  address: string;
  workspace: {
    id: string;
    status: string;
    controller_key: string | null;
    controller_key_id: string | null;
    controller_registered_at: string | null;
    controller_last_seen_at: string | null;
  } | null;
  wallets: Array<{ address: string; chain: string; verified_at: string }>;
  seller: { id: string; public_name: string; description: string; status: string } | null;
}

export interface SellerDashboard {
  seller: { id: string; public_name: string; description: string; status: string } | null;
  listings: Array<{ id: string; slug: string; status: string; current_version_id: string | null; created_at: string }>;
  versions: Array<{
    id: string;
    listing_id: string;
    version_no: number;
    title: string;
    price_base_units: Amount;
    runtime_kind: string;
    template: string | null;
    review_status: string;
    review_note: string | null;
    created_at: string;
  }>;
  payouts: Array<{ id: string; address: string; ata: string; network: string; mint: string; verified_at: string }>;
  jobs: Array<{ id: string; state: string; financial_state: string; listing_version_id: string; created_at: string; updated_at: string }>;
  earnings: Array<{ event_type: string; gross: Amount; fee: Amount; refund: Amount; network: string; mint: string; created_at: string; job_id: string }>;
  totals: Array<{ network: string; mint: string; gross: string; platformFee: string; refunded: string; net: string }>;
  note: string;
  label: string;
}

export interface MarketAgent {
  id: string;
  name: string;
  purpose: string;
  status: "inactive" | "active" | "paused" | "revoked" | "archived" | string;
  tools: string[];
  discovery_enabled: boolean;
  auto_hire_enabled: boolean;
  local_agent_id: string | null;
  created_at: string;
}

export interface PolicyProposal {
  agent_id: string;
  version: number;
  per_task_cap: string;
  per_agent_cap: string;
  max_payment: string;
  period_hours: number;
  allowed_listing_ids: string[];
  status: "proposed" | "acknowledged" | "rejected" | "superseded" | string;
  acknowledged_at: string | null;
  created_at: string;
}

export const AGENT_TOOLS = ["marketplace_search", "propose_hire", "web_read"] as const;
export const MANAGED_TEMPLATES = ["research-summary", "structured-analysis", "content-package"] as const;
