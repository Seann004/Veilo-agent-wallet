/**
 * Purchase state is tracked per leg. An unknown chain or provider outcome is "uncertain"
 * and can only leave that state through observed evidence (finalized, expired_unsettled,
 * delivered or paid_without_result); there is no edge from uncertain to a failure state.
 */
export const PAYMENT_STATE_FIELDS = ["authorization", "funding", "merchant", "fulfilment", "recovery"] as const;
export type PaymentStateField = (typeof PAYMENT_STATE_FIELDS)[number];

export const AUTHORIZATION_STATES = ["proposed", "awaiting_approval", "reserved", "released", "rejected"] as const;
export const FUNDING_STATES = [
  "not_required",
  "not_started",
  "proof_prepared",
  "proof_released",
  "submitted",
  "finalized",
  "uncertain",
  "expired_unsettled",
  "abandoned",
] as const;
export const MERCHANT_STATES = [
  "not_required",
  "not_started",
  "signed",
  "submitted",
  "finalized",
  "uncertain",
  "expired_unsettled",
  "abandoned",
] as const;
export const FULFILMENT_STATES = [
  "not_started",
  "in_progress",
  "delivered",
  "uncertain",
  "paid_without_result",
  "abandoned",
] as const;
export const RECOVERY_STATES = ["none", "recoverable", "recovery_submitted", "uncertain", "recovered"] as const;

export type AuthorizationState = (typeof AUTHORIZATION_STATES)[number];
export type FundingState = (typeof FUNDING_STATES)[number];
export type MerchantState = (typeof MERCHANT_STATES)[number];
export type FulfilmentState = (typeof FULFILMENT_STATES)[number];
export type RecoveryState = (typeof RECOVERY_STATES)[number];

export interface PaymentStates {
  authorization: AuthorizationState;
  funding: FundingState;
  merchant: MerchantState;
  fulfilment: FulfilmentState;
  recovery: RecoveryState;
}

type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export const PAYMENT_TRANSITIONS: {
  authorization: TransitionMap<AuthorizationState>;
  funding: TransitionMap<FundingState>;
  merchant: TransitionMap<MerchantState>;
  fulfilment: TransitionMap<FulfilmentState>;
  recovery: TransitionMap<RecoveryState>;
} = {
  authorization: {
    proposed: ["awaiting_approval", "reserved", "rejected"],
    awaiting_approval: ["reserved", "rejected"],
    reserved: ["released", "rejected"],
    released: [],
    rejected: [],
  },
  funding: {
    not_required: [],
    not_started: ["proof_prepared", "abandoned"],
    proof_prepared: ["proof_released", "abandoned"],
    proof_released: ["submitted", "uncertain", "finalized", "expired_unsettled"],
    submitted: ["finalized", "uncertain", "expired_unsettled"],
    uncertain: ["finalized", "expired_unsettled"],
    finalized: [],
    expired_unsettled: [],
    abandoned: [],
  },
  merchant: {
    not_required: [],
    not_started: ["signed", "abandoned"],
    signed: ["submitted", "uncertain", "finalized", "expired_unsettled"],
    submitted: ["finalized", "uncertain", "expired_unsettled"],
    uncertain: ["finalized", "expired_unsettled"],
    finalized: [],
    expired_unsettled: [],
    abandoned: [],
  },
  fulfilment: {
    not_started: ["in_progress", "abandoned"],
    in_progress: ["delivered", "uncertain", "paid_without_result"],
    uncertain: ["delivered", "paid_without_result"],
    delivered: [],
    paid_without_result: [],
    abandoned: [],
  },
  recovery: {
    none: ["recoverable"],
    recoverable: ["recovery_submitted"],
    recovery_submitted: ["recovered", "uncertain"],
    uncertain: ["recovered", "recoverable"],
    recovered: [],
  },
};

export function canTransition(field: PaymentStateField, from: string, to: string): boolean {
  const map = PAYMENT_TRANSITIONS[field] as Readonly<Record<string, readonly string[]>>;
  return map[from]?.includes(to) ?? false;
}

/** Flattened edge list; the database seeds the same set and enforces it with triggers. */
export function paymentTransitionEdges(): Array<{ field: PaymentStateField; from: string; to: string }> {
  const edges: Array<{ field: PaymentStateField; from: string; to: string }> = [];
  for (const field of PAYMENT_STATE_FIELDS) {
    const map = PAYMENT_TRANSITIONS[field] as Readonly<Record<string, readonly string[]>>;
    for (const [from, targets] of Object.entries(map)) for (const to of targets) edges.push({ field, from, to });
  }
  return edges;
}

/** Owner-facing summary label; never reports an uncertain leg as failed. */
export function paymentStatusLabel(s: PaymentStates): string {
  if (s.authorization === "rejected") return "Rejected";
  if (s.authorization === "awaiting_approval") return "Awaiting owner approval";
  if (s.recovery === "recovered") return "Recovered to owner";
  if (s.recovery !== "none") return "Recovery in progress";
  if (s.fulfilment === "paid_without_result") return "Paid; result unavailable";
  if (s.fulfilment === "delivered") return "Delivered";
  if (s.funding === "uncertain" || s.merchant === "uncertain" || s.fulfilment === "uncertain") {
    return "Waiting for confirmation";
  }
  if (s.funding === "submitted" || s.merchant === "submitted" || s.merchant === "signed") {
    return "Waiting for confirmation";
  }
  if (s.authorization === "released") return "Authorized; in progress";
  return "Reserved";
}

/** Physical token buckets. These are never summed with policy allowance or service credits. */
export const TOKEN_BUCKETS = [
  "approved_unreserved",
  "reserved_input",
  "consumed",
  "pending_change",
  "confirmed_change",
  "payout_balance",
  "merchant_outflow",
  "fee_outflow",
  "external_recovered",
] as const;
export type TokenBucket = (typeof TOKEN_BUCKETS)[number];

export const NOTE_STATES = [
  "pending_deposit",
  "approved",
  "reserved",
  "consumed",
  "pending_change",
  "spendable_change",
  "exited",
] as const;
export type NoteState = (typeof NOTE_STATES)[number];
