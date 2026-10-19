"use client";

import { api } from "../lib/api";
import { usdc } from "../lib/format";
import type { Purchase } from "../lib/types";
import { usePolling, useResource } from "./hooks";
import { TxLink } from "./ui";

interface SwapDetails {
  execution?: { result?: { kind?: string; status?: string; actualOutLamports?: string; minOutLamports?: string; signature?: string; destination?: string } };
}

/** Integer formatting keeps all nine SOL decimals without floating-point rounding. */
export function solAmount(raw: string): string {
  const n = BigInt(raw);
  const tail = (n % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${n / 1_000_000_000n}${tail ? `.${tail}` : ""}`;
}

export function SwapReceipt({ purchase, onDetails }: { purchase: Purchase; onDetails: () => void }) {
  const detail = useResource(() => api<SwapDetails>("control", `/purchases/${purchase.id}`), `swap-${purchase.id}-${purchase.updatedAt}`);
  const result = detail.data?.execution?.result;
  const settled = purchase.states.merchant === "finalized";
  const failed = ["abandoned", "expired_unsettled"].includes(purchase.states.merchant) || ["abandoned", "failed"].includes(purchase.states.fulfilment);
  const actual = settled && result?.status === "finalized" && result.actualOutLamports && /^\d+$/.test(result.actualOutLamports) ? solAmount(result.actualOutLamports) : null;
  usePolling(detail.reload, `swap-receipt-${purchase.id}`, !settled && !failed);
  const signature = result?.signature ?? purchase.chainAttempts?.find((a) => a.leg === "merchant")?.signature;
  return (
    <section className="swap-receipt" aria-label="Swap receipt">
      <div className="swap-receipt-top"><strong>USDC → SOL</strong><span className="small muted">{settled ? "Completed" : failed ? "Not completed" : "Settling"} · Devnet</span></div>
      <p className="swap-receipt-amount">{usdc(purchase.price.amount)} <span aria-hidden="true">→</span> {actual ? `${actual} SOL` : "SOL"}</p>
      <p className="small muted">{actual ? "Actual swap output · sent to your wallet" : settled ? "Swap finalized. Actual output is not available yet." : failed ? "Open payment details to check the outcome and recovery." : "Waiting for chain confirmation. Don’t submit another swap."}</p>
      {result?.destination ? <p className="small muted">To <span title={result.destination}>{result.destination.slice(0, 6)}…{result.destination.slice(-6)}</span></p> : null}
      <div className="swap-receipt-links"><TxLink signature={signature} label="View swap transaction" /><button type="button" className="link-btn" onClick={onDetails}>Payment details</button><button type="button" className="link-btn" disabled={detail.loading} onClick={() => void detail.reload()}>Refresh</button></div>
      {detail.error ? <p className="small muted">Couldn’t refresh the receipt. Your payment has not been retried.</p> : null}
    </section>
  );
}
