// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwapReceipt } from "../components/SwapReceipt";
import { clearResourceCache } from "../components/hooks";
import { purchase, recordingFetch } from "./fixtures";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => clearResourceCache());

describe("live swap receipt", () => {
  it("shows actual finalized SOL rather than the quoted minimum, with a named explorer link", async () => {
    const rec = recordingFetch(() => ({ execution: { result: { status: "finalized", actualOutLamports: "726596", minOutLamports: "700000", signature: "SwapSig", destination: "OwnerDestinationPublicAddress" } } }));
    vi.stubGlobal("fetch", rec.impl);
    render(<SwapReceipt purchase={purchase({ sku: "swap-usdc-to-sol", price: { amount: "10000" } })} onDetails={() => undefined} />);
    expect(await screen.findByText(/0.000726596 SOL/)).toBeTruthy();
    expect(screen.queryByText(/0.0007 SOL/)).toBeNull();
    expect(screen.getByRole("link", { name: /View swap transaction/ }).getAttribute("href")).toContain("SwapSig?cluster=devnet");
    expect(rec.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("does not show a quote as actual output when a finalized receipt has no amount", async () => {
    vi.stubGlobal("fetch", recordingFetch(() => ({ execution: { result: { status: "finalized", minOutLamports: "700000" } } })).impl);
    render(<SwapReceipt purchase={purchase({ sku: "swap-usdc-to-sol" })} onDetails={() => undefined} />);
    expect(await screen.findByText(/Actual output is not available/)).toBeTruthy();
    expect(screen.queryByText(/0.0007 SOL/)).toBeNull();
  });
});
