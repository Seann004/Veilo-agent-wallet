// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityTable } from "../components/Activity";
import { withRole } from "./access-fixtures";
import { purchase, workspace } from "./fixtures";

afterEach(cleanup);

function many(n: number) {
  return Array.from({ length: n }, (_, i) =>
    purchase({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, createdAt: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() }),
  );
}

describe("recent payments table", () => {
  it("lists newest first, capped, with the five columns", () => {
    const ws = workspace();
    render(withRole(<ActivityTable activity={{ events: [], purchases: many(12) }} workspace={ws} onChanged={vi.fn()} limit={8} />, "owner", ws));
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["When", "Agent", "What", "Amount", "Status"]);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(8);
    const first = rows[0]!.textContent ?? "";
    const last = rows[7]!.textContent ?? "";
    expect(first).toContain("Shawn");
    expect(first).toContain("1.00 USDC");
    expect(first).toContain("Delivered");
    // Oct 12 is the newest of the 12 fixtures; Oct 5 is the eighth.
    expect(first).toMatch(/12/);
    expect(last).toMatch(/5/);
    expect(first).not.toEqual(last);
  });

  it("shows prepaid credits instead of a USDC amount", () => {
    const ws = workspace();
    render(withRole(<ActivityTable activity={{ events: [], purchases: [purchase({ paymentPath: "prepaid_credits" })] }} workspace={ws} onChanged={vi.fn()} />, "owner", ws));
    expect(within(screen.getAllByRole("row")[1]!).getByText("prepaid AI credits")).toBeTruthy();
  });

  it("opens the purchase drawer from the keyboard and returns focus on Escape", async () => {
    const user = userEvent.setup();
    const ws = workspace();
    render(withRole(<ActivityTable activity={{ events: [], purchases: [purchase()] }} workspace={ws} onChanged={vi.fn()} />, "owner", ws));
    await user.tab();
    const btn = screen.getByRole("button", { name: "Inference credit pack" });
    expect(document.activeElement).toBe(btn);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("shows an empty message with no payments", () => {
    const ws = workspace();
    render(withRole(<ActivityTable activity={{ events: [], purchases: [] }} workspace={ws} onChanged={vi.fn()} />, "owner", ws));
    expect(screen.getByText(/No payments yet/)).toBeTruthy();
  });
});
