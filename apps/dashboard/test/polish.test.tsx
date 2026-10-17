// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityDrawer, ActivityList } from "../components/Activity";
import { RecoveryCenter } from "../components/RecoveryCenter";
import { OwnerProvider } from "../components/Shell";
import { accessFor, withRole } from "./access-fixtures";
import { ConfirmButton, ErrorNotice } from "../components/ui";
import { ApiError } from "../lib/api";
import { stateSummaries } from "../lib/labels";
import type { Workspace } from "../lib/types";
import { SHAWN, purchase, recordingFetch, workspace } from "./fixtures";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useParams: () => ({}) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const find = (p: Parameters<typeof stateSummaries>[0], group: string) => stateSummaries(p).find((s) => s.group === group)!;

describe("payment, fulfilment and recovery are summarised separately", () => {
  it("keeps an uncertain merchant payment as waiting, never as a problem or a failure", () => {
    const p = purchase({ states: { merchant: "uncertain", fulfilment: "not_started" } });
    expect(find(p, "Payment").tone).toBe("wait");
    expect(find(p, "Payment").text).toMatch(/Uncertain/);
    expect(find(p, "Payment").text).not.toMatch(/fail/i);
    expect(find(p, "Fulfilment").tone).toBe("idle");
    expect(find(p, "Recovery").tone).toBe("idle");
  });

  it("shows paid-without-result as paid on-chain with a problem only on fulfilment", () => {
    const p = purchase({ states: { fulfilment: "paid_without_result" } });
    expect(find(p, "Payment")).toMatchObject({ tone: "ok" });
    expect(find(p, "Fulfilment")).toMatchObject({ tone: "problem", text: "Paid but no result delivered" });
  });

  it("does not report an on-chain payment for prepaid credits", () => {
    const p = purchase({ paymentPath: "prepaid_credits", states: { funding: "not_required", merchant: "not_required", fulfilment: "delivered" } });
    expect(find(p, "Payment").text).toMatch(/no on-chain payment/);
    expect(find(p, "Fulfilment").tone).toBe("ok");
  });

  it("reports recovery on its own axis", () => {
    const p = purchase({ states: { merchant: "expired_unsettled", fulfilment: "not_started", recovery: "recovery_submitted" } });
    expect(find(p, "Payment").tone).toBe("problem");
    expect(find(p, "Recovery")).toMatchObject({ tone: "wait" });
  });

  it("renders the three states in the list and the drawer", () => {
    const ws = workspace();
    render(withRole(<ActivityList activity={{ events: [], purchases: [purchase({ states: { merchant: "submitted", fulfilment: "not_started" } })] }} workspace={ws} onChanged={vi.fn()} />, "owner", ws));
    const strips = screen.getAllByRole("list", { name: "Payment, fulfilment and recovery states" });
    expect(strips).toHaveLength(1);
    expect(within(strips[0]!).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Payment"),
      expect.stringContaining("Fulfilment"),
      expect.stringContaining("Recovery"),
    ]);
  });
});

describe("keyboard focus", () => {
  it("returns focus to the trigger when a confirmation is cancelled with Escape", async () => {
    const user = userEvent.setup();
    render(<ConfirmButton label="Revoke Prince" confirmLabel="Confirm revoke Prince" onConfirm={vi.fn()} />);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm revoke Prince" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Confirm revoke Prince" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Revoke Prince" }));
  });

  it("keeps Tab inside the activity drawer", async () => {
    const user = userEvent.setup();
    render(withRole(<ActivityDrawer purchase={purchase()} events={[]} workspace={workspace()} onClose={vi.fn()} onChanged={vi.fn()} />));
    const dialog = screen.getByRole("dialog");
    const focusable = [...dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
    focusable.at(-1)!.focus();
    await user.tab();
    expect(document.activeElement).toBe(focusable[0]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(focusable.at(-1));
  });
});

describe("error guidance", () => {
  it("explains NOT_READY as a missing capability and offers a retry", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(<ErrorNotice error={new ApiError(503, "NOT_READY", "the wallet service is not reachable")} what="wallet service" onRetry={retry} />);
    expect(screen.getByRole("alert").textContent).toContain("not a failed payment");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("public recovery acknowledgement", () => {
  let rec: ReturnType<typeof recordingFetch>;
  beforeEach(() => {
    document.cookie = "veilo_csrf=csrf-polish";
    const stranded = purchase({ id: "abababab-abab-4bab-8bab-abababababab", agentId: SHAWN, states: { merchant: "expired_unsettled", fulfilment: "not_started", recovery: "recoverable" } });
    rec = recordingFetch((url) => {
      if (url.startsWith("/api/control/activity")) return { events: [], purchases: [stranded] };
      if (url === "/api/wallet/notes/status") return { notes: [], totals: { spendable: { amount: "0" }, reserved: { amount: "0" }, pending: { amount: "0" } } };
      if (url === "/api/wallet/recovery/prepare")
        return { recoveryId: "12121212-1212-4212-8212-121212121212", purchaseId: stranded.id, state: "prepared", amount: { amount: "1000000" }, destinationOwner: "Owner", signature: null, privacyWarning: "Recovery is public." };
      return {};
    });
    vi.stubGlobal("fetch", rec.impl);
  });

  const withOwner = (ws: Workspace, node: ReactNode) => (
    <OwnerProvider value={{ workspace: ws, reloadWorkspace: async () => undefined, connected: null, setConnected: () => undefined, access: accessFor("owner", ws) }}>{node}</OwnerProvider>
  );

  it("requires the owner to acknowledge the privacy impact before confirming", async () => {
    const user = userEvent.setup();
    render(withOwner(workspace(), <RecoveryCenter />));
    await user.click(await screen.findByRole("button", { name: "Prepare recovery" }));
    const confirm = (await screen.findByRole("button", { name: "Confirm public recovery" })) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /recovery is public and links/ }));
    expect(confirm.disabled).toBe(false);
    expect(rec.calls.some((c) => c.url.endsWith("/confirm"))).toBe(false);
  });
});

describe("reason guidance", () => {
  it("explains known codes and invents nothing for unknown ones", async () => {
    const { reasonGuidance } = await import("../lib/labels");
    expect(reasonGuidance("NOTE_PENDING")).toMatch(/Deposit test-USDC/);
    expect(reasonGuidance("SOMETHING_NEW")).toBeNull();
    expect(reasonGuidance(null)).toBeNull();
  });
});

describe("privacy membership honesty", () => {
  it("flags unverified membership instead of calling an unreconciled pool weak", async () => {
    const { PrivacyPanel } = await import("../components/PrivacyPanel");
    vi.stubGlobal(
      "fetch",
      recordingFetch(() => ({
        finalizedSlot: "1",
        consistent: true,
        pool: { minDeposit: "1", maxDeposit: "2", depositsPaused: false, liability: "700000" },
        deposits: [{ amount: "200000", refundAuthority: "A", state: "inserted", label: "1" }],
        spends: [],
        exits: [],
        approved: { labels: [], version: "3", consistent: false, rule: "rule" },
      })).impl,
    );
    render(<PrivacyPanel />);
    expect(await screen.findByText(/verify the pool right now/)).toBeTruthy();
    expect(screen.queryByText(/Weak privacy: only/)).toBeNull();
  });
});
