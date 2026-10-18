// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NotesTable } from "../components/WalletView";
import type { NoteStatus, WalletNote } from "../lib/types";

afterEach(cleanup);

const note = (id: string, amount: string, createdAt: string | null): WalletNote => ({
  id,
  origin: "deposit",
  depositId: null,
  state: "spendable",
  value: { amount },
  leafIndex: 1,
  available: true,
  depositStages: { submitted: true, finalized: true, indexed: true, approved: true, spendable: true },
  refundAuthority: null,
  createdAt,
  updatedAt: createdAt,
});

describe("deposits table", () => {
  it("shows when each note was added, newest first", () => {
    const status: NoteStatus = {
      notes: [note("a", "1000000", "2026-10-17T07:00:00.000Z"), note("b", "2000000", "2026-10-18T08:30:00.000Z"), note("c", "3000000", null)],
      totals: { spendable: { amount: "0" }, reserved: { amount: "0" }, pending: { amount: "0" } },
    };
    render(<NotesTable status={status} />);
    expect(screen.getByRole("columnheader", { name: "Added" })).toBeTruthy();
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("2.00 USDC")).toBeTruthy();
    expect(within(rows[0]!).getByText(/18 Oct 2026/)).toBeTruthy();
    expect(within(rows[2]!).getByText("—")).toBeTruthy();
  });
});
