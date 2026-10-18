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
 * Owner approval of the devnet swap agents may request: any USDC amount up to the approved
 * maximum per swap, sold on Orca for SOL sent to the owner's address. Agents still need the swap
 * in their allowed purchases, and their spending limits still apply.
 */
export function SwapPanel() {
  const svc = useResource(() => api<SwapService>("control", "/swap-service"), "swap-service");
  const [amount, setAmount] = useState("");
  const action = useAction();
  const base = parseUsdcInput(amount);
  const current = svc.data?.service?.status === "approved" ? svc.data.service : null;
  return (
    <Section title="Agent swaps">
      <p className="hint flush">
        Agents can swap USDC for SOL on Orca, paid privately from your pool, choosing any amount up to the maximum you set. The SOL goes to your wallet.
      </p>
      {current ? (
        <p className="small">
          Maximum per swap: <strong>{usdc(current.amount.amount)}</strong>.{" "}
          <button
            type="button"
            className="btn btn-small"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api("control", "/swap-service", { method: "DELETE" });
                await svc.reload();
              })
            }
          >
            Turn off
          </button>
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
          Maximum USDC per swap
        </label>
        <span className="input-unit">
          <input id="swap-amount" inputMode="decimal" placeholder={current ? "New maximum" : "1.00"} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <span aria-hidden="true">USDC</span>
        </span>
        <button type="submit" className="btn btn-primary" disabled={!base || action.busy}>
          {current ? "Update" : "Approve swaps"}
        </button>
      </form>
      {svc.data ? <p className="hint">You can set a maximum of up to {usdc(svc.data.maxAmount.amount)} per swap. Devnet prices aren&apos;t real market prices.</p> : null}
      <ErrorNotice error={svc.error ?? action.error} what="agent swaps" />
    </Section>
  );
}
