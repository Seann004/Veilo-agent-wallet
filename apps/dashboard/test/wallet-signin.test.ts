import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { describe, expect, it, vi } from "vitest";
import { errorGuidance } from "../components/ui";
import { signAndSend, web3SignInAdapter } from "../lib/wallet";

const ADDRESS = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const account = { address: ADDRESS, publicKey: new Uint8Array(32), chains: ["solana:devnet"], features: [] } as unknown as WalletAccount;

function wallet(signedBy: string, withSignIn = true): { w: Wallet; signIn: ReturnType<typeof vi.fn> } {
  const signIn = vi.fn(async () => [{ account: { ...account, address: signedBy }, signedMessage: new Uint8Array([1]), signature: new Uint8Array([2]) }]);
  const features: Record<string, unknown> = { "solana:signMessage": { version: "1.0.0", signMessage: vi.fn() } };
  if (withSignIn) features["solana:signIn"] = { version: "1.0.0", signIn };
  return { w: { features } as unknown as Wallet, signIn };
}

describe("marketplace wallet sign-in adapter", () => {
  it("lets the wallet build the Sign In With Solana message for the connected account", async () => {
    const { w, signIn } = wallet(ADDRESS);
    const out = await web3SignInAdapter(w, account).signIn!({ domain: "localhost:4000", statement: "Sign in" });
    expect(signIn).toHaveBeenCalledWith({ domain: "localhost:4000", statement: "Sign in", address: ADDRESS });
    expect(out.signedMessage).toEqual(new Uint8Array([1]));
    expect(out.signature).toEqual(new Uint8Array([2]));
  });

  it("refuses a sign-in by a different account", async () => {
    const { w } = wallet("Other1111111111111111111111111111111111111");
    await expect(web3SignInAdapter(w, account).signIn!({ domain: "localhost:4000" })).rejects.toThrow(/different account/);
  });

  it("falls back to message signing when the wallet has no signIn feature", () => {
    const { w } = wallet(ADDRESS, false);
    const adapter = web3SignInAdapter(w, account);
    expect(adapter.signIn).toBeUndefined();
    expect(adapter.publicKey.toBase58()).toBe(ADDRESS);
  });
});

describe("wallet transaction signing", () => {
  it("reports a wallet refusal as a wallet error with the wallet's own message, not an unreachable server", async () => {
    const w = { features: { "solana:signAndSendTransaction": { version: "1.0.0", signAndSendTransaction: vi.fn(async () => { throw new Error("Unexpected error"); }) } } } as unknown as Wallet;
    const err = await signAndSend(w, account, "AQ==").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "WALLET_ERROR", message: "Unexpected error" });
    expect(errorGuidance(err as never)).toMatch(/expires after about a minute/);
  });
});
