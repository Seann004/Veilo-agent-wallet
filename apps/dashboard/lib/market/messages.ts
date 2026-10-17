/**
 * Browser-side copies of marketplace strings. The contracts package pulls node:crypto into any
 * bundle that imports it, so these are duplicated here and pinned to the server by tests.
 */
export const TEST_TOKEN_LABEL = "Solana devnet · USDC";

/** Statement shown in the wallet for the Supabase Web3 sign-in. It must stay on one line. */
export const SIGN_IN_STATEMENT = "Sign in to Veilo marketplace. This is a login message, not a transaction or spending approval.";

export const SPENDING_BOUNDARY =
  "Marketplace sign-in identifies you to the catalogue and job board only. It never authorizes spending: every payment still needs your local controller.";

export const DECIMALS_UNVERIFIED = "token decimals not verified by your local controller";

export const NO_BALANCE_NOTE = "Payments settle directly to your payout wallet; Veilo holds no withdrawable balance.";

/** Must match payoutProofMessage in the marketplace service byte for byte. */
export function payoutProofMessage(p: { userId: string; address: string; network: string; mint: string; issuedAt: string }): string {
  return `veilo:payout-proof:v1\n${p.userId}\n${p.address}\n${p.network}\n${p.mint}\n${p.issuedAt}`;
}
