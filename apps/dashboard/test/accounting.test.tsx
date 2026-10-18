// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TreasurySummary } from "../components/TreasurySummary";
import { formatBaseUnits, parseUsdcInput, usdc } from "../lib/format";
import { balancesAfterTopUpAndConsumption, workspace } from "./fixtures";

afterEach(cleanup);

describe("CRE-05 treasury accounting display", () => {
  it("counts cash once and shows no AI credit balance now that AI runs on the owner's key", () => {
    const b = balancesAfterTopUpAndConsumption();
    const { container } = render(<TreasurySummary balances={b} agents={workspace().agents} />);
    expect(screen.getByTestId("cash-spent").textContent).toBe("1.00 USDC");
    const text = container.textContent ?? "";
    expect(text).not.toContain("1.30 USDC");
    expect(text).not.toContain("microcredits");
    expect(text).not.toContain("AI credits");
    expect(text).toContain("Trial AI calls");
    expect(text).toContain("AI runs on your own model key");
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
    expect(screen.getByText(/No agent can spend the whole pool/)).toBeTruthy();
  });

  it("leads with a short stat row holding the key numbers", () => {
    const b = balancesAfterTopUpAndConsumption();
    const { container } = render(<TreasurySummary balances={b} agents={workspace().agents} />);
    const stats = container.querySelector(".stats")!.textContent ?? "";
    expect(stats).toContain("Ready to spend in pool");
    expect(stats).toContain("4.00 USDC");
    expect(stats).toContain("Spent today");
    expect(stats).toContain("1.00 USDC");
    expect(stats).toContain("of 5.00 USDC per 24 h");
    expect(stats).toContain("Lifetime used");
    expect(stats).toContain("of 10.00 USDC cap");
    expect(container.querySelector("details summary")!.textContent).toBe("How limits work");
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
