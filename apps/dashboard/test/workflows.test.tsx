// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketContextProvider, type MarketContextValue } from "../components/market/MarketContext";
import { MarketHome } from "../components/market/MarketHome";
import { WorkflowRunView } from "../components/market/WorkflowRuns";
import { matchRoute } from "../lib/server/proxy";
import type { LocalRun, WorkflowEntry } from "../lib/market/workflows";

vi.mock("next/navigation", () => ({ usePathname: () => "/marketplace", useParams: () => ({}), useRouter: () => ({ push: () => undefined }) }));

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const RECIPIENT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const HOSTILE = `<img src=x onerror="alert(1)"><script>window.__pwned = 1</script>`;
const SIG = "5Br4iPZQWqnc4WxxFDSbnTxkNaDYgcxax3T8VHo6FF8YzryiEZ9zXMEvSzWVmM4zScGjCSa37qKtYHY2BtQDuNvB";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("NEXT_PUBLIC_MARKETPLACE_URL", "http://127.0.0.1:4106");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function market(): MarketContextValue {
  return {
    configured: true,
    ready: true,
    me: null,
    meError: undefined,
    reloadMe: async () => undefined,
    wallet: null,
    mismatch: null,
    canAct: false,
    token: { network: NETWORK, mint: MINT, decimals: 6 },
    decimalsFor: (m: string, n: string) => (m === MINT && n === NETWORK ? 6 : null),
    tokenError: undefined,
    signIn: async () => undefined,
    signOut: async () => undefined,
    disconnectWallet: async () => undefined,
    connectWallet: async () => undefined,
    call: async () => {
      throw new Error("not signed in");
    },
    accessToken: async () => null,
  } as unknown as MarketContextValue;
}
const withMarket = (node: ReactNode) => <MarketContextProvider value={market()}>{node}</MarketContextProvider>;

function workflow(i: number, extra: Partial<WorkflowEntry> = {}): WorkflowEntry {
  return {
    workflow_id: `00000000-0000-4000-8000-00000000000${i}`,
    version_id: `10000000-0000-4000-8000-00000000000${i}`,
    slug: `wf-${i}`,
    creator_name: i === 0 ? HOSTILE : "Demo creator",
    demo: true,
    category: "research",
    title: `Token brief ${i}`,
    summary: "Buys on-chain data, then writes a cited brief.",
    safety_promise: "Read-only; nothing posts without your approval.",
    total_base_units: "13000",
    fee_bps: 0,
    network: NETWORK,
    mint: MINT,
    decimals: 6,
    steps: [
      { index: 0, toolKind: "external", toolId: "t1", title: "Paid RPC", sellerName: "x402", slug: "rpc", kind: "external_x402", provider: null, effect: "read_only", priceBaseUnits: "3000", recipient: RECIPIENT, inputs: {}, output: { kind: "json" } },
      { index: 1, toolKind: "listing", toolId: "t2", title: "Brief writer", sellerName: "Seller", slug: "brief", kind: "managed_template", provider: null, effect: "read_only", priceBaseUnits: "10000", recipient: RECIPIENT, inputs: {}, output: { kind: "markdown" } },
    ],
    paid_runs: i,
    published_at: "2026-10-17T00:00:00Z",
    ...extra,
  };
}

describe("marketplace browse", () => {
  it("lists workflows and starter agents together, filters in place, and shows hostile text as text", async () => {
    const list = [0, 1, 2, 3, 4].map((i) => workflow(i, i === 4 ? { category: "media", title: "Clip maker" } : {}));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (String(url).includes("/listings") ? Response.json({ listings: [] }) : Response.json({ workflows: list }))),
    );
    render(withMarket(<MarketHome />));
    expect(await screen.findAllByText(/per run/)).toHaveLength(5);
    expect(screen.getByRole("heading", { name: "Featured" })).toBeTruthy();
    // Without an owner session a starter agent can't be added; the button says why instead of linking.
    expect(screen.getAllByRole("button", { name: "Add" }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getAllByText(/Solana devnet · USDC/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(HOSTILE).length).toBeGreaterThan(0);
    expect(document.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();

    const cats = screen.getByRole("group", { name: "Categories" });
    expect(within(cats).queryAllByRole("link")).toHaveLength(0);
    fireEvent.click(within(cats).getByRole("button", { name: "Media" }));
    expect(screen.queryByRole("heading", { name: "Featured" })).toBeNull();
    const rows = within(screen.getByRole("list", { name: "Marketplace agents" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent).join(" ")).toContain("Clip maker");
    expect(screen.getAllByText(/per run/)).toHaveLength(1);
  });
});

describe("workflow run view", () => {
  it("keeps payment and execution separate, links signatures to the devnet explorer and shows stop reasons as text", async () => {
    const run: LocalRun = {
      id: "20000000-0000-4000-8000-000000000001",
      cloudRunId: "c",
      workflowVersionId: "v",
      agentId: "a",
      status: "failed",
      isTest: false,
      requestedBy: "owner",
      approvedBy: RECIPIENT,
      approvalDigest: "a".repeat(64),
      terms: { steps: [], totalMaxBaseUnits: "13000", network: NETWORK, mint: MINT },
      total: { amount: "13000", unit: "usdc_base_units" },
      stop: { code: "STEP_FAILED", reason: HOSTILE },
      steps: [
        { index: 0, toolKind: "external", toolId: "t1", recipient: RECIPIENT, max: "3000", state: "delivered", payment: "paid", execution: "delivered", paid: "3000", jobId: null, purchaseId: "p", fundingSignature: SIG, merchantSignatures: [SIG], artifact: { kind: "json", sha256: "b".repeat(64), untrusted: true }, stop: null },
        { index: 1, toolKind: "listing", toolId: "t2", recipient: RECIPIENT, max: "10000", state: "failed", payment: "paid", execution: "failed", paid: "10000", jobId: "j", purchaseId: "q", fundingSignature: null, merchantSignatures: [], artifact: null, stop: { code: "STEP_FAILED", reason: "job failed" } },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ run })));
    render(<WorkflowRunView runId={run.id} />);
    expect((await screen.findAllByText("Failed")).length).toBeGreaterThan(0);
    const steps = screen.getAllByRole("listitem").filter((li) => li.className === "timeline-step");
    expect(steps).toHaveLength(2);
    const pills = [...steps[1]!.querySelectorAll(".pill")].map((p) => p.textContent);
    expect(pills).toEqual(["Failed"]);
    expect(within(steps[0]!).getByText("Delivered")).toBeTruthy();
    const links = within(steps[0]!).getAllByRole("link");
    expect(links.every((a) => (a.getAttribute("href") ?? "").includes("cluster=devnet"))).toBe(true);
    expect(screen.getAllByText((t) => t.includes(HOSTILE)).length).toBeGreaterThan(0);
    expect(document.querySelector("script")).toBeNull();
  });
});

describe("workflow run progress", () => {
  it("shows the waiting reason and plain step states", async () => {
    const base = (i: number, state: string, payment: LocalRun["steps"][number]["payment"], execution: LocalRun["steps"][number]["execution"]): LocalRun["steps"][number] => ({
      index: i, toolKind: "external", toolId: `t${i}`, recipient: RECIPIENT, max: "3000", state, payment, execution, paid: payment === "paid" ? "3000" : null, jobId: null, purchaseId: null, fundingSignature: null, merchantSignatures: [], artifact: null, stop: null,
    });
    const run: LocalRun = {
      id: "20000000-0000-4000-8000-000000000002", cloudRunId: "c", workflowVersionId: "v", agentId: "a", status: "running", isTest: false, requestedBy: "owner", approvedBy: RECIPIENT, approvalDigest: "a".repeat(64),
      terms: { steps: [], totalMaxBaseUnits: "9000", network: NETWORK, mint: MINT },
      total: { amount: "9000", unit: "usdc_base_units" },
      stop: null,
      waiting: { code: "PRIVATE_POOL_PENDING", reason: "Waiting for your private balance to settle.", since: "2026-10-18T00:00:00Z" },
      steps: [base(0, "paid", "paid", "delivered"), base(1, "hiring", "not_paid", "not_run"), base(2, "pending", "not_paid", "not_run")],
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ run })));
    render(<WorkflowRunView runId={run.id} />);
    expect(await screen.findByText("Waiting for your private balance to settle.")).toBeTruthy();
    expect(document.querySelector(".run-head .pill")?.textContent).toBe("Waiting");
    const pills = [...document.querySelectorAll(".timeline-step .pill")].map((p) => p.textContent);
    expect(pills).toEqual(["Delivered", "Getting a quote", "Not started"]);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });
});

describe("dashboard proxy", () => {
  it("lets the owner reach workflow runs and assignments but never the agent proposal route", () => {
    const id = "20000000-0000-4000-8000-000000000001";
    expect(matchRoute("control", "POST", "/workflows/runs")).toBeTruthy();
    expect(matchRoute("control", "POST", `/workflows/runs/${id}/approve`)).toBeTruthy();
    expect(matchRoute("control", "GET", `/workflows/runs/${id}/steps/0/artifact`)).toBeTruthy();
    expect(matchRoute("control", "POST", "/workflows/assignments")).toBeTruthy();
    expect(matchRoute("control", "POST", "/worker/workflow-runs")).toBeUndefined();
    expect(matchRoute("control", "POST", `/workflows/runs/${id}/steps/9/artifact`)).toBeUndefined();
  });
});
