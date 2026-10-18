// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CREDIT_LABEL as CONTRACT_CREDIT_LABEL, SPONSORED_PLANNING_LABEL as CONTRACT_PLANNING_LABEL } from "@veilo/contracts/gateway";
import { paymentStatusLabel } from "@veilo/contracts";
import { ActivityDrawer } from "../components/Activity";
import { withRole } from "./access-fixtures";
import { NetworkStatus } from "../components/NetworkStatus";
import {
  GATEWAY_CREDIT_LABEL,
  LABEL_CREDITS_NO_CHARGE,
  LABEL_PAID_NO_RESULT,
  LABEL_STOPPED_AUTHORIZED,
  LABEL_WAITING,
  SPONSORED_PLANNING_LABEL,
  purchaseLabel,
} from "../lib/labels";
import type { Purchase } from "../lib/types";
import { PRINCE, SHAWN, agent, purchase, workspace } from "./fixtures";

afterEach(cleanup);

const withLabel = (p: Purchase): Purchase => ({ ...p, label: paymentStatusLabel(p.states as Parameters<typeof paymentStatusLabel>[0]) });

describe("owner-facing labels", () => {
  it("match the shared contract wording", () => {
    expect(GATEWAY_CREDIT_LABEL).toBe(CONTRACT_CREDIT_LABEL);
    expect(GATEWAY_CREDIT_LABEL).toBe("Demo inference credits — backed by the operator's OpenRouter account");
    expect(SPONSORED_PLANNING_LABEL).toBe(CONTRACT_PLANNING_LABEL);
  });

  it("uses the exact human labels for paid-without-result, uncertain, stopped and prepaid states", () => {
    const paidNoResult = withLabel(purchase({ states: { fulfilment: "paid_without_result" } }));
    expect(purchaseLabel(paidNoResult, { agentStopped: false })).toBe("Paid; result unavailable");

    const uncertain = withLabel(purchase({ states: { merchant: "uncertain", fulfilment: "not_started" } }));
    expect(purchaseLabel(uncertain, { agentStopped: false })).toBe("Waiting for confirmation");

    const released = withLabel(purchase({ states: { funding: "finalized", merchant: "signed", fulfilment: "not_started" } }));
    expect(purchaseLabel(released, { agentStopped: true })).toBe("Stopped; one payment already authorized");

    const prepaid = withLabel(purchase({ paymentPath: "prepaid_credits", sku: "summarize", states: { funding: "not_required", merchant: "not_required" } }));
    expect(purchaseLabel(prepaid, { agentStopped: false })).toBe("Credits purchased; no extra on-chain charge for this call");

    expect([LABEL_PAID_NO_RESULT, LABEL_WAITING, LABEL_STOPPED_AUTHORIZED, LABEL_CREDITS_NO_CHARGE]).toEqual([
      "Paid; result unavailable",
      "Waiting for confirmation",
      "Stopped; one payment already authorized",
      "Credits purchased; no extra on-chain charge for this call",
    ]);
  });

  it("renders the stopped label in the activity drawer with legs, signatures and devnet explorer links", () => {
    const ws = workspace({ agents: [agent(SHAWN, "Shawn", "credit_manager", "revoked"), agent(PRINCE, "Prince", "research")] });
    const p = withLabel(purchase({ states: { merchant: "submitted", fulfilment: "not_started" } }));
    render(withRole(<ActivityDrawer purchase={p} events={[]} workspace={ws} onClose={vi.fn()} onChanged={vi.fn()} />, "owner", ws));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(LABEL_STOPPED_AUTHORIZED)).toBeTruthy();
    expect(within(dialog).getByText("Funding (pool withdrawal to fresh wallet)")).toBeTruthy();
    expect(within(dialog).getByText("Merchant (x402 settlement)")).toBeTruthy();
    expect(within(dialog).getByText(`submitted: ${LABEL_WAITING}`)).toBeTruthy();
    const links = within(dialog).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links.some((h) => h?.startsWith("https://explorer.solana.com/tx/FundSig") && h.endsWith("?cluster=devnet"))).toBe(true);
    expect(links.some((h) => h?.startsWith("https://explorer.solana.com/tx/MerchSig") && h.endsWith("?cluster=devnet"))).toBe(true);
    expect(within(dialog).getByText("Credits below threshold")).toBeTruthy();
    expect(within(dialog).getByText(/veilo-gateway/)).toBeTruthy();
  });

  it("shows paid-without-result in the drawer", () => {
    const p = withLabel(purchase({ states: { fulfilment: "paid_without_result" } }));
    render(withRole(<ActivityDrawer purchase={p} events={[]} workspace={workspace()} onClose={vi.fn()} onChanged={vi.fn()} />));
    expect(screen.getAllByText(LABEL_PAID_NO_RESULT).length).toBeGreaterThan(0);
  });

  it("shows live on devnet only when the verified identity matches the workspace", () => {
    const ws = workspace().workspace;
    const identity = { genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", caip2: ws.network, mint: ws.mint, mintDecimals: 6, checkedAt: "" };
    const { rerender } = render(<NetworkStatus health={{ service: "control", status: "ok", network: ws.network, chain: { state: "verified", identity } }} healthError={undefined} workspace={ws} />);
    expect(screen.getByRole("status").textContent).toBe("Live on Solana devnet");
    rerender(<NetworkStatus health={{ service: "control", status: "unavailable", network: ws.network, chain: { state: "unavailable", reason: "x" } }} healthError={undefined} workspace={ws} />);
    expect(screen.getByRole("status").textContent).toContain("Solana devnet");
    expect(screen.getByRole("status").textContent).toContain("not confirmed");
    rerender(<NetworkStatus health={{ service: "control", status: "ok", network: ws.network, chain: { state: "verified", identity: { ...identity, mint: "Other" } } }} healthError={undefined} workspace={ws} />);
    expect(screen.getByRole("status").textContent).toContain("mismatch");
  });
});
