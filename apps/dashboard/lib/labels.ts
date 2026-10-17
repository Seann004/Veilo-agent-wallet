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
