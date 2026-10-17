// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketContextProvider, type MarketContextValue } from "../components/market/MarketContext";
import { WorkflowBrowse } from "../components/market/WorkflowBrowse";
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

describe("workflow browse", () => {
  it("shows category tabs as links, prices in test tokens, the chain, and hostile text as text", async () => {
    const list = [0, 1, 2, 3, 4].map((i) => workflow(i));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workflows: list })));
    render(withMarket(<WorkflowBrowse />));
    const tabs = await screen.findByRole("navigation", { name: "Categories" });
    expect(within(tabs).getByRole("link", { name: "Research" }).getAttribute("href")).toBe("/marketplace/c/research");
    expect(within(tabs).getByRole("link", { name: "All" }).getAttribute("aria-current")).toBe("page");
    expect(await screen.findByRole("link", { name: "View all" })).toBeTruthy();
    expect(screen.getAllByText(/per run/).length).toBe(4);
    expect(screen.getAllByText(/Devnet test tokens/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("list", { name: "Tool chain" })[0]!.textContent).toContain("RPC");
    expect(screen.getAllByText(HOSTILE).length).toBeGreaterThan(0);
    expect(document.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
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
    expect(await screen.findByText(/Stopped — later steps were not bought/)).toBeTruthy();
    const steps = screen.getAllByRole("listitem").filter((li) => li.className === "timeline-step");
    expect(steps).toHaveLength(2);
    const pills = [...steps[1]!.querySelectorAll(".pill")].map((p) => p.textContent);
    expect(pills).toEqual(["Paid", "Failed"]);
    const links = within(steps[0]!).getAllByRole("link");
    expect(links.every((a) => (a.getAttribute("href") ?? "").includes("cluster=devnet"))).toBe(true);
    expect(screen.getAllByText((t) => t.includes(HOSTILE)).length).toBeGreaterThan(0);
    expect(document.querySelector("script")).toBeNull();
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
