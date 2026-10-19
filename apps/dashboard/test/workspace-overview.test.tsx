// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StackedBar } from "../components/Charts";
import { PoolTotal } from "../components/WalletView";
import { Overview } from "../components/Overview";
import { WalletView } from "../components/WalletView";
import { dailySpend, paidOnChain, percent, treasuryParts } from "../lib/spend";
import type { Job, PublicState, Task } from "../lib/types";
import { withRole } from "./access-fixtures";
import { MIRA, PRINCE, SHAWN, agent, balancesAfterTopUpAndConsumption, purchase, recordingFetch, workspace } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = new Date(2026, 9, 19, 15, 0);
const at = (daysAgo: number, hour = 10) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysAgo, hour).toISOString();

describe("spending series", () => {
  it("counts only settled private payments, per local day, oldest first", () => {
    const purchases = [
      purchase({ id: "a", settledAt: at(0), createdAt: at(0) }),
      purchase({ id: "b", settledAt: at(0, 11), createdAt: at(0, 11), price: { amount: "250000" } }),
      purchase({ id: "c", settledAt: at(2), createdAt: at(2) }),
      // Not counted: still settling, prepaid credits, and older than the window.
      purchase({ id: "d", settledAt: null, createdAt: at(1), states: { merchant: "submitted" } }),
      purchase({ id: "e", settledAt: at(1), createdAt: at(1), paymentPath: "prepaid_credits", states: { merchant: "not_required" } }),
      purchase({ id: "f", settledAt: at(9), createdAt: at(9) }),
    ];
    const s = dailySpend(purchases, NOW, 7, 200);
    expect(s.days).toHaveLength(7);
    expect(s.days.map((d) => d.total.toString())).toEqual(["0", "0", "0", "0", "1000000", "0", "1250000"]);
    expect(s.days.at(-1)!.count).toBe(2);
    expect(s.complete).toBe(true);
    expect(paidOnChain(purchases[3]!)).toBe(false);
  });

  it("flags a full page that does not reach back to the first day", () => {
    const page = [purchase({ id: "a", settledAt: at(0), createdAt: at(0) }), purchase({ id: "b", settledAt: at(1), createdAt: at(1) })];
    expect(dailySpend(page, NOW, 7, 2).complete).toBe(false);
    expect(dailySpend(page, NOW, 7, 3).complete).toBe(true);
    // Created-time pagination cannot rule out an older purchase settling in this window.
    page[1]!.createdAt = at(9);
    expect(dailySpend(page, NOW, 7, 2).complete).toBe(false);
  });

  it("splits pool buckets by readiness and withholds them in the public view", () => {
    const b = balancesAfterTopUpAndConsumption();
    b.tokens.buckets = { ...b.tokens.buckets, confirmed_change: "500000", reserved_input: "250000", pending_change: "100000", payout_balance: "30000" };
    expect(treasuryParts(b)).toEqual({ ready: "4500000", held: "250000", pending: "100000", outside: "30000" });
    delete b.tokens.buckets;
    expect(treasuryParts(b)).toBeNull();
    expect(percent("1", "3")).toBe(33.33);
    expect(percent("5", "0")).toBe(0);
    expect(percent("9", "3")).toBe(100);
  });
});

function overviewFetch() {
  const failedTask = { id: "t1", agentId: PRINCE, objective: "Research repair cafes", state: "failed" } as Task;
  const failedJob = { id: "j1", agentId: PRINCE, taskId: "t1", kind: "custom", state: "failed", result: { didWork: true, artifactId: null, notes: [] } } as unknown as Job;
  return recordingFetch((url) => {
    if (url.startsWith("/api/control/balances")) return balancesAfterTopUpAndConsumption();
    if (url.startsWith("/api/control/tasks")) return { tasks: [failedTask], jobs: [failedJob] };
    if (url.startsWith("/api/control/activity")) return { events: [], purchases: [purchase({ settledAt: new Date().toISOString(), createdAt: new Date().toISOString() })] };
    if (url.startsWith("/api/control/ai-provider")) return { provider: { provider: "deepseek", model: "deepseek-chat" } };
    return {};
  });
}

describe("workspace overview", () => {
  let rec: ReturnType<typeof recordingFetch>;
  beforeEach(() => {
    rec = overviewFetch();
    vi.stubGlobal("fetch", rec.impl);
  });

  it("shows agents as cards with a budget meter and a short last result, and hides archived agents behind a count", async () => {
    const user = userEvent.setup();
    const ws = workspace({ agents: [agent(SHAWN, "Shawn", "credit_manager"), agent(PRINCE, "Prince", "research"), agent(MIRA, "Mira", "content", "archived")] });
    render(withRole(<Overview />, "owner", ws));
    await waitFor(() => expect(document.querySelectorAll(".agent-grid > li")).toHaveLength(2));
    const prince = [...document.querySelectorAll(".agent-grid > li")].find((li) => li.textContent?.includes("Prince")) as HTMLElement;
    expect(within(prince).getByRole("link").getAttribute("href")).toBe(`/agents/${PRINCE}`);
    expect(within(prince).getByText("Researcher")).toBeTruthy();
    await waitFor(() => expect(within(prince).getByRole("meter").getAttribute("aria-valuetext")).toBe("2.00 USDC left of 2.00 USDC"));
    await waitFor(() => expect(within(prince).getByText("Failed · The answer wasn't saved")).toBeTruthy());

    // Archived agents are not cards; they sit behind one small disclosure.
    expect(document.querySelector(".agent-grid")!.textContent).not.toContain("Mira");
    const summary = screen.getByText("Archived (1)");
    await user.click(summary);
    expect(screen.getByRole("link", { name: /Mira/ }).getAttribute("href")).toBe(`/agents/${MIRA}`);
  });

  it("charts today's settled spend against the 24 h limit, the treasury split and spend per agent", async () => {
    render(withRole(<Overview />, "owner"));
    const today = await screen.findByRole("img", { name: /1\.00 USDC paid, 1 payment$/ });
    expect(today).toBeTruthy();
    expect(screen.getByText("24 h limit")).toBeTruthy();
    const treasury = screen.getByRole("img", { name: /^Your pool funds:/ });
    expect(treasury.getAttribute("aria-label")).toBe("Your pool funds: Ready to spend 4.00 USDC, Held for purchases 0.00 USDC, On the way 0.00 USDC");
    const byAgent = screen.getByRole("heading", { name: "By agent" }).closest("section")!;
    // Only agents that paid or hold funds are listed.
    expect(byAgent.textContent).toContain("Shawn");
    expect(byAgent.textContent).not.toContain("Prince");
    expect(screen.getByRole("meter", { name: "Workspace limit left today" }).getAttribute("aria-valuetext")).toBe("4.00 USDC left of 5.00 USDC");
    expect(rec.calls.some((c) => c.url === "/api/control/activity?limit=200")).toBe(true);
  });
});

describe("wallet pool total", () => {
  const publicState = (refundAuthorities: string[]): PublicState => ({
    finalizedSlot: "1",
    consistent: true,
    pool: { minDeposit: "100000", maxDeposit: "20000000", depositsPaused: false, liability: "5830000" },
    deposits: refundAuthorities.map((r, i) => ({ amount: "1000000", refundAuthority: r, state: "approved", label: String(i + 1) })),
    spends: [],
    exits: [],
    approved: { labels: refundAuthorities.map((_, i) => String(i + 1)), version: "1", consistent: true, rule: "all" },
  });

  it("shows the whole pool from the chain beside the owner's share and flags a small pool", async () => {
    const rec = recordingFetch((url) => {
      if (url.startsWith("/api/wallet/notes/status")) return { notes: [], totals: { spendable: { amount: "1230000" }, reserved: { amount: "0" }, pending: { amount: "0" } } };
      if (url.startsWith("/api/relayer/public-state")) return publicState(["A", "A", "B"]);
      if (url.startsWith("/api/control/swap-service")) return { maxAmount: { amount: "1000000" } };
      return {};
    });
    vi.stubGlobal("fetch", rec.impl);
    render(withRole(<WalletView />, "owner"));
    const card = (await screen.findByRole("heading", { name: "Pool total (all depositors)" })).closest("section")!;
    await waitFor(() => expect(card.textContent).toContain("5.83 USDC"));
    expect(card.textContent).toContain("All depositors · public on Solana devnet");
    const facts = within(card).getByText("Approved depositor addresses").parentElement!;
    expect(facts.textContent).toBe("Approved depositor addresses2");
    await waitFor(() => expect(within(card).getByRole("img", { name: /^Pool total:/ }).getAttribute("aria-label")).toBe(
      "Pool total: Yours, ready to spend 1.23 USDC, Yours, held for purchases 0.00 USDC, Rest of the pool 4.60 USDC",
    ));
    expect(within(card).getByRole("status").textContent).toMatch(/Small pool: 2 approved depositor addresses/);
    // The owner's own figure stays separate.
    expect(screen.getByText("Ready to spend").parentElement!.textContent).toContain("1.23 USDC");
  });
});


describe("chart honesty", () => {
  it("keeps a small nonzero segment proportional instead of inflating its size", () => {
    render(<StackedBar label="Funds" segments={[{ key: "a", label: "Small", value: "1", slot: 1 }, { key: "b", label: "Large", value: "999", slot: 2 }]} />);
    const segments = document.querySelectorAll<HTMLElement>(".stacked-seg");
    expect(segments[0]!.style.flexGrow).toBe("0.1");
    expect(segments[1]!.style.flexGrow).toBe("99.9");
  });

  it("withholds the owner's split and warns when public membership cannot be verified", async () => {
    const rec = recordingFetch(() => ({ consistent: false, finalizedSlot: "1", pool: { liability: "1000000" }, deposits: [], spends: [], exits: [], approved: { labels: [], version: "1", consistent: false, rule: "all" } }));
    vi.stubGlobal("fetch", rec.impl);
    render(<PoolTotal notes={{ notes: [], totals: { spendable: { amount: "1000000" }, reserved: { amount: "0" }, pending: { amount: "0" } } } as unknown as import("../lib/types").NoteStatus} />);
    await screen.findByText(/Pool membership could not be verified/);
    expect(screen.queryByRole("img", { name: /^Pool total:/ })).toBeNull();
    expect(screen.queryByText(/Small pool:/)).toBeNull();
  });
});
