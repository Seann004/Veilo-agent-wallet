// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityList } from "../components/Activity";
import { AgentControls } from "../components/AgentControls";
import { RecoveryCenter, classifyRecovery } from "../components/RecoveryCenter";
import { OwnerProvider } from "../components/Shell";
import { EmergencyStop, STOP_KEEPS_RECOVERY } from "../components/StopControls";
import type { Workspace } from "../lib/types";
import { accessFor, withRole } from "./access-fixtures";
import { PRINCE, SHAWN, agent, purchase, recordingFetch, workspace } from "./fixtures";

vi.mock("next/navigation", () => ({ usePathname: () => "/recovery", useParams: () => ({}) }));

let rec: ReturnType<typeof recordingFetch>;
let responder: (url: string) => unknown;
beforeEach(() => {
  document.cookie = "veilo_csrf=csrf-stop";
  responder = () => ({});
  rec = recordingFetch((url) => responder(url));
  vi.stubGlobal("fetch", rec.impl);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function withOwner(ws: Workspace, node: ReactNode) {
  return <OwnerProvider value={{ workspace: ws, reloadWorkspace: async () => undefined, connected: null, setConnected: () => undefined, access: accessFor("owner", ws) }}>{node}</OwnerProvider>;
}

describe("stop paths", () => {
  it("pauses an agent with the keyboard and revokes only after an explicit confirmation", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    render(withRole(<AgentControls agent={agent(PRINCE, "Prince", "research")} onChanged={onChanged} />));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Pause Prince" }));
    await user.keyboard("{Enter}");
    expect(rec.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST /api/control/agents/${PRINCE}/pause`]);
    expect(rec.calls[0]!.headers["x-csrf-token"]).toBe("csrf-stop");

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Revoke Prince" }));
    await user.keyboard(" ");
    expect(rec.calls).toHaveLength(1);
    // Focus moves to the confirm button so the next key press is deliberate.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm revoke Prince" }));
    await user.keyboard("{Enter}");
    expect(rec.calls.map((c) => c.url)).toContain(`/api/control/agents/${PRINCE}/revoke`);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  });

  it("disables pause/revoke for a revoked agent but still allows archive", () => {
    render(withRole(<AgentControls agent={agent(PRINCE, "Prince", "research", "revoked")} onChanged={vi.fn()} />));
    expect((screen.getByRole("button", { name: "Pause Prince" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Revoke Prince" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Archive Prince" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("triggers the global emergency stop and states that recovery and exit stay available", async () => {
    const user = userEvent.setup();
    render(withRole(<EmergencyStop stopped={false} onChanged={vi.fn()} />));
    expect(screen.getByText(STOP_KEEPS_RECOVERY)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Emergency stop all agents" }));
    await user.click(screen.getByRole("button", { name: "Confirm emergency stop" }));
    expect(rec.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/control/workspace/stop"]);
  });

  it("keeps recovery and public exit available during an emergency stop", async () => {
    const user = userEvent.setup();
    const ws = workspace({ stopped: true });
    const stranded = purchase({ id: "abababab-abab-4bab-8bab-abababababab", agentId: SHAWN, states: { merchant: "expired_unsettled", fulfilment: "not_started", recovery: "recoverable" } });
    const pending = purchase({ id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd", agentId: SHAWN, states: { merchant: "signed", fulfilment: "not_started" } });
    responder = (url) => {
      if (url.startsWith("/api/control/activity")) return { events: [], purchases: [stranded, pending] };
      if (url === "/api/wallet/notes/status")
        return {
          notes: [{ id: "efefefef-efef-4fef-8fef-efefefefefef", origin: "deposit", depositId: null, state: "spendable", value: { amount: "2000000" }, leafIndex: 0, available: true, refundAuthority: "Owner" }],
          totals: { spendable: { amount: "2000000" }, reserved: { amount: "0" }, pending: { amount: "0" } },
        };
      if (url === "/api/wallet/recovery/prepare")
        return { recoveryId: "12121212-1212-4212-8212-121212121212", purchaseId: stranded.id, state: "prepared", amount: { amount: "1000000" }, destinationOwner: "Owner", signature: null, privacyWarning: "Recovery is public and linkable." };
      return {};
    };
    render(withOwner(ws, <RecoveryCenter />));
    const prepare = await screen.findByRole("button", { name: "Prepare recovery" });
    expect((prepare as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Not yet safe: a payment already sent may still go through/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prepare public exit" })).toBeTruthy();
    expect(screen.getByText(/a public exit is linkable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume workspace" })).toBeTruthy();
    await user.click(prepare);
    expect(await screen.findByText(/Recovery is public and linkable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm public recovery" })).toBeTruthy();
    const walletCall = rec.calls.find((c) => c.url === "/api/wallet/recovery/prepare")!;
    expect(walletCall.body).toEqual({ purchaseId: stranded.id });
    expect(walletCall.headers["x-csrf-token"]).toBe("csrf-stop");
  });

  it("classifies a funded wallet as pending while its merchant leg may still be signed", () => {
    expect(classifyRecovery(purchase({ states: { merchant: "not_started", fulfilment: "not_started" } }), false)).toBe("pending");
    expect(classifyRecovery(purchase({ states: { merchant: "not_started", fulfilment: "not_started" } }), true)).toBe("safe");
    expect(classifyRecovery(purchase({ states: { merchant: "uncertain", fulfilment: "not_started" } }), true)).toBe("pending");
    expect(classifyRecovery(purchase(), true)).toBe("none");
  });
});

describe("keyboard operability", () => {
  it("opens the activity drawer from the keyboard, closes on Escape and returns focus", async () => {
    const user = userEvent.setup();
    const ws = workspace();
    render(withRole(<ActivityList activity={{ events: [], purchases: [purchase()] }} workspace={ws} onChanged={vi.fn()} />, "owner", ws));
    await user.tab();
    const row = screen.getByRole("button", { name: /Shawn · Inference credit pack/ });
    expect(document.activeElement).toBe(row);
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(row);
  });
});
