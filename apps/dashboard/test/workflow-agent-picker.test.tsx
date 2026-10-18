// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketContextProvider, type MarketContextValue } from "../components/market/MarketContext";
import { WorkflowDetail } from "../components/market/WorkflowDetail";
import { hiringAgents, type WorkflowEntry } from "../lib/market/workflows";
import type { Agent, Policy } from "../lib/types";

vi.mock("next/navigation", () => ({ usePathname: () => "/marketplace", useParams: () => ({}), useRouter: () => ({ push: () => undefined }) }));

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

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

function agent(id: string, name: string, status: Agent["status"], skus: string[] | null): Agent {
  const activePolicy = skus === null ? null : ({ permissions: { allowedSkus: skus, allowedPaymentPaths: ["private_x402"] } } as unknown as Policy);
  return { id, name, role: "custom", status, description: null, trigger: {}, modelProfile: null, policyVersion: 1, activePolicy, revocationEpoch: 0, updatedAt: "2026-10-18T00:00:00Z" };
}

const entry = {
  workflow_id: "00000000-0000-4000-8000-000000000001",
  version_id: "10000000-0000-4000-8000-000000000001",
  slug: "wf-1",
  creator_name: "Demo creator",
  demo: true,
  category: "research",
  title: "Token brief",
  summary: "Buys data, then writes a brief.",
  safety_promise: null,
  total_base_units: "13000",
  fee_bps: 0,
  network: NETWORK,
  mint: MINT,
  decimals: 6,
  steps: [],
  paid_runs: 0,
  published_at: "2026-10-17T00:00:00Z",
} as unknown as WorkflowEntry;

describe("hiringAgents", () => {
  it("keeps only active agents whose active policy allows specialist-job", () => {
    const all = [
      agent("a", "Hirer", "active", ["analyze", "specialist-job"]),
      agent("b", "No hiring", "active", ["analyze"]),
      agent("c", "Draft", "draft", ["specialist-job"]),
      agent("d", "No policy", "active", null),
    ];
    expect(hiringAgents(all).map((a) => a.name)).toEqual(["Hirer"]);
  });
});

describe("run-once agent picker", () => {
  async function openRun(agents: Agent[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (String(url).includes("/api/control/workspace") ? Response.json({ workspace: {}, agents, policies: [], services: [] }) : Response.json({ workflow: entry }))),
    );
    render(withMarket(<WorkflowDetail slug="wf-1" />));
    fireEvent.click(within(await screen.findByRole("navigation", { name: "Sections" })).getByRole("button", { name: /Run once/ }));
  }

  it("explains whose limits apply and lists only agents that can hire", async () => {
    await openRun([agent("a", "Hirer", "active", ["specialist-job"]), agent("b", "No hiring", "active", ["analyze"])]);
    expect(await screen.findByText("Which agent's limits cover this run")).toBeTruthy();
    expect(screen.getByText("Paid from your private pool. Only agents that are on and allowed to hire appear here.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Which agent's limits cover this run/ }));
    const names = within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["Choose an agent", "Hirer"]);
    expect(screen.queryByRole("link", { name: "Create an agent" })).toBeNull();
  });

  it("links to agent creation when no agent can hire", async () => {
    await openRun([agent("b", "No hiring", "active", ["analyze"])]);
    const link = await screen.findByRole("link", { name: "Create an agent" });
    expect(link.getAttribute("href")).toBe("/agents/new");
  });
});
