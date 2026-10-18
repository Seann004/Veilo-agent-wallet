import { LABEL_PAID_NO_RESULT } from "../labels";
import type { StateTone } from "../labels";

export interface StateView {
  axis: "Execution" | "Payment";
  state: string;
  text: string;
  tone: StateTone;
}

export interface JobPresentation {
  execution: StateView;
  financial: StateView;
  /** True only when a finalized on-chain receipt funds this job. */
  paid: boolean;
  /** Paid, and the work did not (or may not) produce a result: the refund path applies. */
  paidWithoutResult: boolean;
  /** Further polling can change what is shown. */
  live: boolean;
  notes: string[];
}

const EXECUTION: Record<string, [string, StateTone]> = {
  created: ["Created", "idle"],
  awaiting_approval: ["Waiting for your approval", "wait"],
  awaiting_payment: ["Waiting for payment by your local controller", "wait"],
  queued: ["Queued for the seller", "wait"],
  running: ["Running", "wait"],
  input_required: ["Seller needs your input", "wait"],
  cancel_requested: ["Cancel requested", "wait"],
  succeeded: ["Delivered", "ok"],
  cancelled: ["Cancelled", "idle"],
  failed: ["Failed", "problem"],
  delivery_uncertain: ["Delivery uncertain: not confirmed delivered or failed", "wait"],
  expired: ["Expired", "idle"],
};

const FINANCIAL: Record<string, [string, StateTone]> = {
  free: ["Free quote: no payment", "ok"],
  quoted: ["Quoted: not paid", "idle"],
  approval_pending: ["Not paid: awaiting approval", "wait"],
  reserved: ["Reserved by your local controller: not paid yet", "wait"],
  funding_pending: ["Payment in progress: not settled", "wait"],
  funded: ["Payment funded: settlement pending", "wait"],
  settlement_pending: ["Settlement pending", "wait"],
  settled: ["Paid: settled on chain", "ok"],
  rejected: ["Not paid: declined or cancelled", "idle"],
  expired_unpaid: ["Not paid: quote expired", "idle"],
  funding_uncertain: ["Payment outcome uncertain: reconciling", "wait"],
  settlement_uncertain: ["Payment outcome uncertain: reconciling", "wait"],
  failed_unpaid: ["Payment failed: nothing was paid", "problem"],
  refund_requested: ["Paid: refund requested", "wait"],
  partially_refunded: ["Paid: partially refunded", "ok"],
  refunded: ["Paid: refunded in full", "ok"],
};

const TERMINAL_EXECUTION = new Set(["succeeded", "cancelled", "failed", "expired"]);
const SETTLED_FINANCIAL = new Set(["settled", "refund_requested", "partially_refunded", "refunded"]);
const PENDING_FINANCIAL = new Set([
  "approval_pending",
  "reserved",
  "funding_pending",
  "funded",
  "settlement_pending",
  "funding_uncertain",
  "settlement_uncertain",
  "refund_requested",
]);

/**
 * Presents execution and payment as two independent indicators. Payment success never reads as
 * job success and a failed job never hides that it was paid.
 */
export function presentJob(job: { state: string; financial_state: string }, opts: { hasReceipt?: boolean } = {}): JobPresentation {
  const [eText, eTone] = EXECUTION[job.state] ?? [`Unknown state (${job.state})`, "wait" as StateTone];
  const [fText, fTone] = FINANCIAL[job.financial_state] ?? [`Unknown payment state (${job.financial_state})`, "wait" as StateTone];
  const paid = SETTLED_FINANCIAL.has(job.financial_state) || opts.hasReceipt === true;
  const noResult = job.state === "failed" || job.state === "cancelled" || job.state === "expired" || job.state === "delivery_uncertain";
  const paidWithoutResult = paid && noResult;
  const notes: string[] = [];
  if (paidWithoutResult) {
    notes.push(
      job.state === "delivery_uncertain"
        ? "Paid; delivery is uncertain. The payment stays recorded while the seller's outcome is resolved."
        : `${LABEL_PAID_NO_RESULT}. The payment stays recorded; you can request a seller-funded refund.`,
    );
  }
  if (job.state === "succeeded" && !paid && job.financial_state !== "free") notes.push("Delivered, but no settled payment is recorded for this job.");
  return {
    execution: { axis: "Execution", state: job.state, text: eText, tone: eTone },
    financial: { axis: "Payment", state: job.financial_state, text: fText, tone: fTone },
    paid,
    paidWithoutResult,
    live: !TERMINAL_EXECUTION.has(job.state) || PENDING_FINANCIAL.has(job.financial_state),
    notes,
  };
}
