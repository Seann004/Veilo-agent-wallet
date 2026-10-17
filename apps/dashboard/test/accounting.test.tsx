// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TreasurySummary } from "../components/TreasurySummary";
import { formatBaseUnits, parseUsdcInput, usdc } from "../lib/format";
import { balancesAfterTopUpAndConsumption, workspace } from "./fixtures";

afterEach(cleanup);

describe("CRE-05 treasury accounting display", () => {
  it("counts a credit-pack purchase once as cash and shows later consumption only in microcredits", () => {
    const b = balancesAfterTopUpAndConsumption();
    const { container } = render(<TreasurySummary balances={b} agents={workspace().agents} />);
    expect(screen.getByTestId("cash-spent").textContent).toBe("1.00 USDC");
    const text = container.textContent ?? "";
    // Purchase (1.00 USDC) plus consumption (300,000 microcredits) must never appear as 1.30 USDC.
    expect(text).not.toContain("1.30 USDC");
    expect(text).toContain("Credits purchased1,000,000 microcredits");
    expect(text).toContain("Credits consumed300,000 microcredits");
    expect(text).toContain("Credits available700,000 microcredits");
    expect(text).toContain("Credits purchased; no extra on-chain charge for this call");
    expect(text).toContain("Demo inference credits — backed by the operator's OpenRouter account");
    expect(text).toContain("(already in cash spent)");
    expect(text).toContain("operator-sponsored planning");
  });

  it("shows per-agent and global remaining together and caps effective remaining by the workspace", () => {
    const b = balancesAfterTopUpAndConsumption();
    if (b.workspace.policyVersion !== null) {
      b.workspace.rolling24h = { limit: "5000000", settled: "4800000", reserved: "0", available: "200000", overCommitted: "0" };
    }
    render(<TreasurySummary balances={b} agents={workspace().agents} />);
    const princeRow = screen.getByRole("rowheader", { name: /Prince/ }).closest("tr")!;
    expect(princeRow.textContent).toContain("2.00 USDC of 2.00 USDC");
    // Effective remaining is the workspace's 0.2 USDC, not Prince's 2.0 or the 4.0 pool value.
    expect(princeRow.querySelector("td strong")!.textContent).toBe("0.20 USDC");
    expect(screen.getByText(/no agent can spend the whole pool/)).toBeTruthy();
  });

  it("reports unavailable gateway credits honestly instead of inventing a balance", () => {
    const b = balancesAfterTopUpAndConsumption();
    b.gatewayCredits = { available: false, code: "NOT_READY", message: "gateway balance unavailable" };
    const { container } = render(<TreasurySummary balances={b} agents={workspace().agents} />);
    expect(container.textContent).toContain("Not ready: gateway balance unavailable (NOT_READY)");
    expect(container.textContent).not.toContain("Credits available");
  });

  it("formats and parses amounts with integer arithmetic", () => {
    expect(formatBaseUnits("123456789", 6)).toBe("123.456789");
    expect(formatBaseUnits("9223372036854775807", 6)).toBe("9,223,372,036,854.775807");
    expect(usdc("1500000")).toBe("1.50 USDC");
    expect(usdc("1")).toBe("0.000001 USDC");
    expect(usdc("123456789")).toBe("123.456789 USDC");
    expect(parseUsdcInput("1.5")).toBe("1500000");
    expect(parseUsdcInput("0.000001")).toBe("1");
    expect(parseUsdcInput("1.0000001")).toBeNull();
    expect(parseUsdcInput("-1")).toBeNull();
  });
});
