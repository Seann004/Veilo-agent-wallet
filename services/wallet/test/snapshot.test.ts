import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorld, type TestWallet, type World } from "./harness";

let world: World;
let w: TestWallet;
beforeEach(async () => { world = await createWorld(); w = world.open(); });
afterEach(() => world.cleanup());

describe("wallet balance snapshot", () => {
  it("returns stored balances immediately during a slow chain read and coalesces concurrent syncs", async () => {
    const original = w.deps.pool;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    w.deps.pool = async () => { reads++; await wait; return original(); };
    const first = w.notes.sync();
    expect(w.notes.sync()).toBe(first);
    expect(w.notes.snapshot()).toMatchObject({ totals: { spendable: { amount: "0" } }, sync: { refreshing: true, synced: false } });
    expect(reads).toBe(1);
    release();
    await first;
    expect(w.notes.snapshot()).toMatchObject({ sync: { refreshing: false, synced: true } });
    expect(reads).toBe(1);
  });
  it("preserves a sync failure alongside local balances without claiming the chain is current", async () => {
    w.deps.pool = async () => { throw new Error("RPC unavailable"); };
    await w.notes.sync();
    expect(w.notes.snapshot()).toMatchObject({ totals: { spendable: { amount: "0" } }, sync: { refreshing: false, synced: false, reason: "RPC unavailable" } });
  });
});
