// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyReviewGroups, ROLE_TEMPLATES } from "../components/Policy";
import { MarketContextProvider, type MarketContextValue } from "../components/market/MarketContext";
import { RunTermsView } from "../components/market/WorkflowDetail";
import type { LocalRun, WorkflowEntry } from "../lib/market/workflows";

vi.mock("next/navigation", () => ({ usePathname: () => "/marketplace", useParams: () => ({}), useRouter: () => ({ push: () => undefined }) }));

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const RECIPIENT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

afterEach(cleanup);

const ctx = { decimalsFor: () => 6 } as unknown as MarketContextValue;

describe("workflow terms", () => {
  it("lists steps in a table with a total and keeps base units and the digest behind technical details", () => {
    const w = { mint: MINT, network: NETWORK, steps: [{ title: "Paid RPC" }, { title: "Brief writer" }] } as unknown as WorkflowEntry;
    const run = {
      approvalDigest: "d".repeat(64),
      terms: {
        steps: [
          { toolKind: "external", toolId: "t1", recipient: RECIPIENT, maxBaseUnits: "130000", toolDigest: "x" },
          { toolKind: "listing", toolId: "t2", recipient: RECIPIENT, maxBaseUnits: "100000", toolDigest: "y" },
        ],
        totalMaxBaseUnits: "230000",
        network: NETWORK,
        mint: MINT,
      },
    } as unknown as LocalRun;
    render(
      <MarketContextProvider value={ctx}>
        <RunTermsView run={run} w={w} onApprove={() => undefined} busy={false} />
      </MarketContextProvider>,
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]!.textContent).toContain("Paid RPC");
    expect(rows[2]!.textContent).toContain("Brief writer");
    expect(screen.getByText(/Total up to/).textContent).toContain("0.23");
    expect(screen.getByText(/Total up to/).textContent).toContain("Solana devnet");
    const details = document.querySelector("details.tech-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("230000");
    expect(details.textContent).toContain("d".repeat(64));
    expect(screen.getByRole("button", { name: "Approve and run" })).toBeTruthy();
  });

  it("names each step's external effect and warns before approving a public post", () => {
    const w = {
      mint: MINT,
      network: NETWORK,
      steps: [
        { index: 0, title: "Planner", effect: "read_only", provider: null },
        { index: 1, title: "Draft", effect: "draft_external", provider: "zernio" },
        { index: 2, title: "Publish", effect: "publish_external", provider: "zernio_publish" },
      ],
    } as unknown as WorkflowEntry;
    const step = { toolKind: "listing", toolId: "t", recipient: RECIPIENT, maxBaseUnits: "10000", toolDigest: "x" };
    const run = { approvalDigest: "d".repeat(64), terms: { steps: [step, step, step], totalMaxBaseUnits: "30000", network: NETWORK, mint: MINT } } as unknown as LocalRun;
    render(
      <MarketContextProvider value={ctx}>
        <RunTermsView run={run} w={w} onApprove={() => undefined} busy={false} />
      </MarketContextProvider>,
    );
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows[0]!.textContent).toContain("Effect");
    expect(rows[1]!.textContent).toContain("Read-only");
    expect(rows[2]!.textContent).toContain("Drafts only");
    expect(rows[3]!.textContent).toContain("Publishes publicly to TikTok");
    expect(screen.getByRole("note").textContent).toContain("Step 3: Publishes publicly to TikTok.");
  });
});

describe("agent review summary", () => {
  it("groups spending, purchases as chips and access", () => {
    render(<PolicyReviewGroups policy={ROLE_TEMPLATES.research.policy} workspacePolicy={undefined} title="Scout" hiring={{ allowed: true, grants: 2 }} />);
    const spending = screen.getByRole("region", { name: "Spending" });
    for (const k of ["Spends", "Per purchase", "Per task", "Per day", "Total budget"]) expect(within(spending).getByText(k)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Can buy" })).getAllByRole("listitem").length).toBeGreaterThan(0);
    const access = screen.getByRole("region", { name: "Access" });
    expect(access.textContent).toContain("Web browsing");
    expect(access.textContent).toContain("2 pre-approved listings");
    expect(access.textContent).toContain("Pays with");
  });
});
