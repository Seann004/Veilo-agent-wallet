// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityDrawer } from "../components/Activity";
import { AgentControls } from "../components/AgentControls";
import { ResearchForm } from "../components/AgentDetail";
import { ContentEditor } from "../components/Content";
import { CreateAgent } from "../components/CreateAgent";
import { RecoveryCenter } from "../components/RecoveryCenter";
import { Shell } from "../components/Shell";
import { EmergencyStop } from "../components/StopControls";
import { WalletView } from "../components/WalletView";
import { can, deniedReason, type AccessRole } from "../lib/access";
import type { Purchase } from "../lib/types";
import { GUEST_ADDRESS, withRole } from "./access-fixtures";
import { PRINCE, agent, draft, purchase, recordingFetch, workspace } from "./fixtures";

vi.mock("next/navigation", () => ({ usePathname: () => "/workspace", useParams: () => ({}) }));

let rec: ReturnType<typeof recordingFetch>;
beforeEach(() => {
  rec = recordingFetch(() => ({}));
  vi.stubGlobal("fetch", rec.impl);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("role capabilities", () => {
  it("lets guests run but keeps every other action with the owner", () => {
    const roles: AccessRole[] = ["owner", "guest", "viewer"];
    const table = Object.fromEntries(
      (["run", "configure", "create", "stop", "fund", "recover", "decide", "review", "archive", "connectors"] as const).map((c) => [c, roles.filter((r) => can({ role: r, address: null }, c))]),
    );
    expect(table).toEqual({
      run: ["owner", "guest"],
      configure: ["owner"],
      create: ["owner"],
      stop: ["owner"],
      fund: ["owner"],
      recover: ["owner"],
      decide: ["owner"],
      review: ["owner"],
      archive: ["owner"],
      connectors: ["owner"],
    });
    expect(deniedReason({ role: "owner", address: null }, "stop")).toBeNull();
    expect(deniedReason({ role: "guest", address: null }, "stop")).toMatch(/owner/);
    expect(deniedReason({ role: "viewer", address: null }, "run")).toMatch(/Sign in/);
  });
});

describe.each<[AccessRole, { stop: boolean; run: boolean; budget: boolean; decide: boolean; review: boolean }]>([
  ["owner", { stop: true, run: true, budget: true, decide: true, review: true }],
  ["guest", { stop: false, run: true, budget: false, decide: false, review: false }],
  ["viewer", { stop: false, run: false, budget: false, decide: false, review: false }],
])("%s controls", (role, allowed) => {
  it("enables only the controls this role may use and explains the rest", () => {
    render(
      withRole(
        <>
          <AgentControls agent={agent(PRINCE, "Prince", "research")} onChanged={vi.fn()} />
          <EmergencyStop stopped={false} onChanged={vi.fn()} />
        </>,
        role,
      ),
    );
    expect(button("Pause Prince").disabled).toBe(!allowed.stop);
    expect(button("Revoke Prince").disabled).toBe(!allowed.stop);
    expect(button("Archive Prince").disabled).toBe(!allowed.stop);
    expect(button("Emergency stop all agents").disabled).toBe(!allowed.stop);
    expect(screen.queryAllByText(/Only the workspace owner|Read-only view/).length > 0).toBe(!allowed.stop);
  });

  it("gates research runs and the task budget field", () => {
    render(withRole(<ResearchForm agent={agent(PRINCE, "Prince", "research")} disabled={false} onQueued={vi.fn()} />, role));
    const textarea = screen.getByLabelText("Research question") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(!allowed.run);
    expect(screen.queryByLabelText("Task budget (USDC, optional)") !== null).toBe(allowed.budget);
  });

  it("gates purchase decisions and reconcile", () => {
    const p = purchase({ states: { authorization: "awaiting_approval" } });
    render(withRole(<ActivityDrawer purchase={p} events={[]} workspace={workspace()} onClose={vi.fn()} onChanged={vi.fn()} />, role));
    expect(button("Approve purchase").disabled).toBe(!allowed.decide);
    expect(button("Reject purchase").disabled).toBe(!allowed.decide);
    expect(button("Reconcile with chain and gateway").disabled).toBe(!allowed.decide);
  });

  it("gates content review and keeps text read-only for non-owners", () => {
    render(withRole(<ContentEditor item={draft()} onSaved={vi.fn()} />, role));
    const body = screen.getByLabelText("Draft text") as HTMLTextAreaElement;
    expect(body.readOnly).toBe(!allowed.review);
    for (const b of screen.getAllByRole("button", { name: /^Mark / }) as HTMLButtonElement[]) expect(b.disabled).toBe(!allowed.review);
  });
});

describe("owner-only pages", () => {
  it.each<AccessRole>(["guest", "viewer"])("never requests wallet notes and shows a notice for %s", async (role) => {
    render(withRole(<><WalletView /><RecoveryCenter /><CreateAgent /></>, role));
    expect(screen.getByText(/The private wallet is owner-only/)).toBeTruthy();
    expect(screen.getByText(/Recovery and withdrawal is owner-only/)).toBeTruthy();
    expect(screen.getByText(/Creating agents is owner-only/)).toBeTruthy();
    expect(screen.queryByLabelText("Amount")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.calls.some((c) => c.url.startsWith("/api/wallet/"))).toBe(false);
  });

  it("renders a redacted public purchase without operation identifiers or chain attempts", () => {
    const redacted: Partial<Purchase> = { ...purchase() };
    delete redacted.operationId;
    delete redacted.chainAttempts;
    delete redacted.stateReason;
    render(withRole(<ActivityDrawer purchase={redacted as Purchase} events={[]} workspace={workspace()} onClose={vi.fn()} onChanged={vi.fn()} />, "viewer"));
    expect(screen.queryByText("Operation ID")).toBeNull();
    expect(screen.queryByText("Chain attempts")).toBeNull();
    expect(document.body.textContent).not.toContain("undefined");
  });
});

function shellFetch(session: Record<string, unknown>, workspaceStatus = 200) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/control/session") return json(session);
    if (url === "/api/control/workspace") {
      return workspaceStatus === 200 ? json(workspace()) : json({ error: { code: "UNAUTHENTICATED", message: "valid credentials are required" } }, workspaceStatus);
    }
    if (url === "/api/control/health") return json({ service: "control", status: "ok", network: "solana:devnet", chain: { state: "pending" } });
    return json({});
  });
}

describe("shell access", () => {
  it("shows the read-only banner and a Sign in button to the public viewer", async () => {
    vi.stubGlobal("fetch", shellFetch({ role: "viewer", address: null, expiresAt: null, publicView: true }));
    render(
      <Shell>
        <p>page body</p>
      </Shell>,
    );
    expect(await screen.findByText("Read-only public view.")).toBeTruthy();
    expect(screen.getByText("page body")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Sign in" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.getByText("Public viewer")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Create agent" })).toBeNull();
  });

  it("shows the guest role and address with Sign out", async () => {
    vi.stubGlobal("fetch", shellFetch({ role: "guest", address: GUEST_ADDRESS, expiresAt: "2026-10-18T00:00:00.000Z", publicView: false }));
    render(
      <Shell>
        <p>page body</p>
      </Shell>,
    );
    expect(await screen.findByText("Guest")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByText("Read-only public view.")).toBeNull();
  });

  it("asks for sign-in when there is no session and public view is off", async () => {
    vi.stubGlobal("fetch", shellFetch({ role: "none", address: null, expiresAt: null, publicView: false }, 401));
    render(
      <Shell>
        <p>page body</p>
      </Shell>,
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy());
    expect(screen.queryByText("page body")).toBeNull();
    expect(screen.getByText(/owner wallet or an approved guest wallet/)).toBeTruthy();
  });
});
