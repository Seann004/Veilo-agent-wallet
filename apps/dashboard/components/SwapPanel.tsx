"use client";

import { useState } from "react";
import { api } from "../lib/api";
import { parseUsdcInput, usdc } from "../lib/format";
import { useAction, useResource } from "./hooks";
import { ErrorNotice, Section } from "./ui";

interface SwapService {
  sku: string;
  whirlpool: string;
  maxAmount: { amount: string };
  service: { id: string; status: string; amount: { amount: string } } | null;
}

/**
 * Owner approval of the devnet swap agents may request: a fixed USDC amount sold on Orca for
 * SOL sent to the owner's address. Agents still need the swap in their allowed purchases.
 */
export function SwapPanel() {
  const svc = useResource(() => api<SwapService>("control", "/swap-service"), "swap-service");
  const [amount, setAmount] = useState("");
  const action = useAction();
  const base = parseUsdcInput(amount);
  const current = svc.data?.service;
  return (
    <Section title="Agent swaps">
      <p className="hint flush">
        Let an agent swap USDC for SOL on Orca (Solana devnet). Each swap is funded privately from your pool by a fresh wallet, and the SOL is sent to your
        address. Agents can only use it once you add “Swap usdc to sol” to their spending limits.
      </p>
      {current ? (
        <p className="small">
          Approved: <strong>{usdc(current.amount.amount)}</strong> per swap.
        </p>
      ) : null}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!base) return;
          void action.run(async () => {
            await api("control", "/swap-service", { method: "POST", body: { amountUsdc: base } });
            setAmount("");
            await svc.reload();
          });
        }}
      >
        <label className="sr-only" htmlFor="swap-amount">
          USDC per swap
        </label>
        <span className="input-unit">
          <input id="swap-amount" inputMode="decimal" placeholder={current ? "New amount" : "1.00"} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <span aria-hidden="true">USDC</span>
        </span>
        <button type="submit" className="btn btn-primary" disabled={!base || action.busy}>
          {current ? "Update" : "Approve swaps"}
        </button>
      </form>
      {svc.data ? <p className="hint">Up to {usdc(svc.data.maxAmount.amount)} per swap. The devnet pool is shallow and its price is not a real market price.</p> : null}
      <ErrorNotice error={svc.error ?? action.error} what="agent swaps" />
    </Section>
  );
}
