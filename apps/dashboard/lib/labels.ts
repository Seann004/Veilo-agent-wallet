import type { AgentRole, AgentStatus, PaymentStates, Purchase } from "./types";

export const GATEWAY_CREDIT_LABEL = "Demo inference credits — backed by the operator's OpenRouter account";
export const OPERATOR_INFERENCE_LABEL = "Inference is operator-funded (OpenRouter); devnet test tokens do not buy real provider credits.";
export const SPONSORED_PLANNING_LABEL = "operator-sponsored planning";

export const LABEL_PAID_NO_RESULT = "Paid; result unavailable";
export const LABEL_WAITING = "Waiting for confirmation";
export const LABEL_STOPPED_AUTHORIZED = "Stopped; one payment already authorized";
export const LABEL_CREDITS_NO_CHARGE = "Credits purchased; no extra on-chain charge for this call";

export const ROLE_LABEL: Record<AgentRole, string> = {
  credit_manager: "Inference-credit manager",
  research: "Research agent",
  content: "Content manager",
};

/** Owner-facing agent state: revoked/archived agents and an emergency stop read as stopped. */
export function agentStateLabel(status: AgentStatus, workspaceStopped: boolean): string {
  if (status === "archived") return "Stopped (archived)";
  if (status === "revoked") return "Stopped (revoked)";
  if (workspaceStopped) return "Stopped (emergency stop)";
  if (status === "paused") return "Paused";
  if (status === "draft") return "Draft — awaiting owner activation";
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
    return LABEL_CREDITS_NO_CHARGE;
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
  else if (prepaid) payment = { tone: "idle", text: "Prepaid credits: no on-chain payment for this call" };
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
