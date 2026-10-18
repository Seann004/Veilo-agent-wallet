import type { AgentRole, AgentStatus, PaymentStates, Purchase } from "./types";

export const GATEWAY_CREDIT_LABEL = "Demo inference credits — backed by the operator's OpenRouter account";
export const OPERATOR_INFERENCE_LABEL = "Inference is operator-funded (OpenRouter); devnet USDC does not buy provider credits.";
export const SPONSORED_PLANNING_LABEL = "operator-sponsored planning";

export const LABEL_PAID_NO_RESULT = "Paid; result unavailable";
export const LABEL_WAITING = "Waiting for confirmation";
export const LABEL_STOPPED_AUTHORIZED = "Stopped; one payment already authorized";
export const LABEL_CREDITS_NO_CHARGE = "Credits purchased; no extra on-chain charge for this call";

export const ROLE_LABEL: Record<AgentRole, string> = {
  credit_manager: "Credit manager",
  research: "Researcher",
  content: "Content writer",
  custom: "Custom agent",
};

/** Owner-facing agent state: revoked/archived agents and an emergency stop read as stopped. */
export function agentStateLabel(status: AgentStatus, workspaceStopped: boolean): string {
  if (status === "archived") return "Stopped (archived)";
  if (status === "revoked") return "Stopped (revoked)";
  if (workspaceStopped) return "Stopped (emergency stop)";
  if (status === "paused") return "Paused";
  if (status === "draft") return "Draft";
  return "Active";
}

const UNRESOLVED_FUNDING = new Set(["proof_released", "submitted", "uncertain"]);
const UNRESOLVED_MERCHANT = new Set(["signed", "submitted", "uncertain"]);

/** Released proof or signature material that may still settle. */
export function hasLiveAuthority(s: PaymentStates): boolean {
  return (
    s.authorization === "released" &&
    (UNRESOLVED_FUNDING.has(s.funding) || UNRESOLVED_MERCHANT.has(s.merchant) || s.fulfilment === "in_progress" || s.fulfilment === "uncertain")
  );
}

/**
 * Summary label for a purchase. It refines the control service label with the stop context and
 * the payment path; it never turns an uncertain leg into a failure.
 */
export function purchaseLabel(p: Pick<Purchase, "states" | "label" | "paymentPath">, ctx: { agentStopped: boolean }): string {
  const s = p.states;
  if (s.fulfilment === "paid_without_result") return LABEL_PAID_NO_RESULT;
  if (ctx.agentStopped && hasLiveAuthority(s)) return LABEL_STOPPED_AUTHORIZED;
  if (p.paymentPath === "prepaid_credits" && s.authorization !== "rejected" && s.authorization !== "awaiting_approval") {
    if (s.fulfilment === "uncertain" || s.fulfilment === "in_progress") return LABEL_WAITING;
    // Only a delivered call used credits; an abandoned one keeps control's own label.
    if (s.fulfilment === "delivered") return LABEL_CREDITS_NO_CHARGE;
    return p.label;
  }
  return p.label;
}

export const LEG_LABEL: Record<keyof PaymentStates, string> = {
  authorization: "Authorization",
  funding: "Funding (pool withdrawal to fresh wallet)",
  merchant: "Merchant (x402 settlement)",
  fulfilment: "Fulfilment",
  recovery: "Recovery",
};

export function legStateLabel(state: string): string {
  switch (state) {
    case "uncertain":
    case "submitted":
    case "signed":
    case "proof_released":
      return `${state.replace(/_/g, " ")} — ${LABEL_WAITING}`;
    case "paid_without_result":
      return LABEL_PAID_NO_RESULT;
    case "not_required":
      return "not required for this payment path";
    default:
      return state.replace(/_/g, " ");
  }
}

export const REVIEW_LABEL: Record<string, string> = {
  draft: "Draft",
  needs_review: "Needs review",
  approved_for_export: "Approved for export",
  archived: "Archived",
};

export type StateTone = "ok" | "wait" | "problem" | "idle";
export interface StateSummary {
  group: "Payment" | "Fulfilment" | "Recovery";
  tone: StateTone;
  text: string;
}

/**
 * Three independent owner-facing summaries derived from the leg states. An unknown outcome stays
 * "uncertain" (tone wait); only a proven outcome is shown as problem.
 */
export function stateSummaries(p: Pick<Purchase, "states" | "paymentPath">): [StateSummary, StateSummary, StateSummary] {
  const s = p.states;
  const prepaid = p.paymentPath === "prepaid_credits";
  let payment: Omit<StateSummary, "group">;
  if (s.authorization === "rejected") payment = { tone: "idle", text: "Not paid: rejected by policy" };
  else if (s.authorization === "awaiting_approval") payment = { tone: "wait", text: "Not paid yet: awaiting your approval" };
  else if (prepaid) payment = { tone: "idle", text: "AI credits: no on-chain payment for this call" };
  else if (s.merchant === "finalized") payment = { tone: "ok", text: "Paid on-chain: merchant settlement finalized" };
  else if (s.merchant === "uncertain") payment = { tone: "wait", text: "Uncertain: the payment may have settled, checking the chain" };
  else if (s.merchant === "submitted" || s.merchant === "signed") payment = { tone: "wait", text: "Waiting for confirmation: merchant payment signed or submitted" };
  else if (s.merchant === "expired_unsettled") payment = { tone: "problem", text: "Not paid: signed payment expired unsettled (proven)" };
  else if (s.funding === "uncertain") payment = { tone: "wait", text: "Uncertain: pool withdrawal outcome unknown, checking the chain" };
  else if (s.funding === "proof_released" || s.funding === "submitted") payment = { tone: "wait", text: "Waiting for confirmation: pool withdrawal in flight" };
  else if (s.funding === "expired_unsettled") payment = { tone: "problem", text: "Not funded: pool withdrawal expired unsettled (proven)" };
  else if (s.funding === "finalized") payment = { tone: "wait", text: "Fresh wallet funded; merchant not paid yet" };
  else if (s.merchant === "abandoned" || s.funding === "abandoned") payment = { tone: "idle", text: "Not paid: abandoned before any payment" };
  else payment = { tone: "idle", text: "Not paid yet: reserved only" };

  let fulfilment: Omit<StateSummary, "group">;
  switch (s.fulfilment) {
    case "delivered":
      fulfilment = { tone: "ok", text: "Result delivered" };
      break;
    case "in_progress":
      fulfilment = { tone: "wait", text: "In progress" };
      break;
    case "uncertain":
      fulfilment = { tone: "wait", text: "Uncertain: checking with the gateway" };
      break;
    case "paid_without_result":
      fulfilment = { tone: "problem", text: "Paid but no result delivered" };
      break;
    case "abandoned":
      fulfilment = { tone: "idle", text: "Abandoned; nothing delivered" };
      break;
    default:
      fulfilment = { tone: "idle", text: "Not started" };
  }

  let recovery: Omit<StateSummary, "group">;
  switch (s.recovery) {
    case "recovered":
      recovery = { tone: "ok", text: "Recovered to owner account" };
      break;
    case "recoverable":
      recovery = { tone: "wait", text: "Recoverable: owner action needed" };
      break;
    case "recovery_submitted":
      recovery = { tone: "wait", text: "Recovery submitted; waiting for confirmation" };
      break;
    case "uncertain":
      recovery = { tone: "wait", text: "Uncertain: recovery outcome unknown, checking the chain" };
      break;
    default:
      recovery = { tone: "idle", text: "Nothing to recover" };
  }
  return [
    { group: "Payment", ...payment },
    { group: "Fulfilment", ...fulfilment },
    { group: "Recovery", ...recovery },
  ];
}

const REASON_GUIDANCE: Record<string, string> = {
  POLICY_DENIED: "A policy rule blocked this request at authorization. Review the agent and workspace policies.",
  BUDGET_EXCEEDED: "A spending limit would be exceeded, so authorization was refused. Raise the limit in a new policy version or wait for the 24 h window.",
  SERVICE_NOT_ALLOWED: "The service or SKU is not on the agent's allow-list, so authorization was refused.",
  PRICE_CHANGED: "The quoted price moved past the pinned price, so the request was refused. Check Activity for the payment state.",
  ACCOUNT_STOPPED: "The agent or workspace is stopped, so no new authority is issued.",
  APPROVAL_REQUIRED: "This purchase needs your approval in Activity before it can proceed.",
  NOTE_PENDING: "No spendable pool note is available yet. Deposit USDC in Wallet and wait for it to reach the spendable stage.",
  SETTLEMENT_UNCERTAIN: "The chain outcome is not known yet. This is not a failure: reconcile from Activity.",
  QUOTE_EXPIRED: "The merchant quote expired. Check Activity to confirm nothing was charged; the agent may request a new quote.",
  PROVIDER_UNAVAILABLE: "The inference provider could not serve the call. Check Activity before assuming anything was charged.",
  PAID_NO_RESULT: "Paid, but no result was delivered. Open the payment in Activity.",
  RECOVERY_REQUIRED: "Funds sit in a fresh wallet. Use the Recovery center once the outcome is proven.",
  WRONG_NETWORK: "The network is not Solana devnet. Payments are refused.",
  WRONG_MINT: "The token mint is not the pinned devnet USDC. Payments are refused.",
  paused_after_rejection: "The agent paused itself after a rejection and waits for you.",
};

/** Plain-language meaning of a backend reason or error code; unknown codes get no invented explanation. */
export function reasonGuidance(code: string | null | undefined): string | null {
  return code ? (REASON_GUIDANCE[code] ?? null) : null;
}

/** Why an agent cannot start work right now; null when it can. */
export function runBlockedReason(status: AgentStatus, workspaceStopped: boolean): string | null {
  if (workspaceStopped) return "Everything is stopped. Resume from the Workspace page to start work again.";
  switch (status) {
    case "draft":
      return "This agent is off. Turn it on to approve its spending limits and let it start work.";
    case "paused":
      return "This agent is paused. Resume it to start work.";
    case "revoked":
    case "archived":
      return "This agent is stopped for good.";
    default:
      return null;
  }
}

export type SkuGroup = "Data" | "AI work" | "Paid APIs" | "Swaps" | "Hiring" | "Other";

const SKU_INFO: Record<string, { label: string; group: SkuGroup }> = {
  "research-basic": { label: "Research data", group: "Data" },
  "research-expanded": { label: "Research data (more sources)", group: "Data" },
  "external-x402-batch": { label: "Paid APIs", group: "Paid APIs" },
  summarize: { label: "Summaries", group: "AI work" },
  analyze: { label: "Analysis", group: "AI work" },
  "content-package": { label: "Content drafts", group: "AI work" },
  "swap-usdc-to-sol": { label: "Swap USDC to SOL", group: "Swaps" },
  "specialist-job": { label: "Hire a specialist", group: "Hiring" },
};

/** Plain names for what an agent can buy; unknown SKUs fall back to their own name. */
export const skuLabel = (sku: string): string => SKU_INFO[sku]?.label ?? sku.charAt(0).toUpperCase() + sku.slice(1).replace(/-/g, " ");
export const skuGroup = (sku: string): SkuGroup => SKU_INFO[sku]?.group ?? "Other";
/** Retired: AI now runs on the owner's own key, so credit packs are never offered. */
export const HIDDEN_SKUS = new Set(["inference-credit-pack"]);

const TASK_STATE: Record<string, string> = {
  queued: "Waiting",
  running: "Working",
  completed: "Done",
  incomplete: "Stopped part-way",
  failed: "Failed",
  cancelled: "Cancelled",
};
export const taskStateLabel = (state: string): string => TASK_STATE[state] ?? state.replace(/_/g, " ");

const CODE_TEXT: Record<string, string> = {
  BUDGET_EXCEEDED: "over its budget",
  NOTE_PENDING: "no spendable USDC in the pool",
  SERVICE_NOT_ALLOWED: "not allowed by its limits",
  POLICY_DENIED: "not allowed",
  ACCOUNT_STOPPED: "agent is off",
  NOT_READY: "not ready yet",
  PROVIDER_UNAVAILABLE: "service unavailable",
};

/** Replaces "(CODE: technical message)" in an outcome with a plain reason. */
export const plainOutcome = (text: string): string =>
  text.replace(/\(([A-Z][A-Z_]+)(?::[^)]*)?\)/g, (_, code: string) => `(${CODE_TEXT[code] ?? code.toLowerCase().replace(/_/g, " ")})`);

/**
 * A payment with nothing left to happen: delivered and settled on chain, or abandoned before any
 * money moved, with no recovery under way. Anything else still shows where it stands.
 */
export function isSettled(st: { authorization: string; merchant: string; fulfilment: string; recovery: string }): boolean {
  if (st.recovery === "recovered") return true;
  if (st.recovery !== "none") return false;
  if (st.authorization === "rejected") return true;
  if (st.authorization !== "released") return false;
  // Prepaid credit calls have no merchant leg.
  if (st.fulfilment === "delivered") return st.merchant === "finalized" || st.merchant === "not_required";
  return st.fulfilment === "abandoned" && (st.merchant === "not_started" || st.merchant === "not_required");
}
