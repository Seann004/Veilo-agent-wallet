/**
 * Named marketplace defaults. These are product starting points, not provider guarantees;
 * deployments may tighten them but code must read them from here rather than hardcode them.
 */
export const MARKETPLACE_LIMITS = {
  quoteTtlSeconds: 300,
  /** A buyer controller releases a private proof only while the quote has at least this long left. */
  minQuoteRemainingSeconds: 120,
  leaseSeconds: 60,
  heartbeatSeconds: 15,
  downloadLinkSeconds: 60,
  activeExecutionSeconds: 600,
  inputResponseWindowSeconds: 86_400,
  maxToolCalls: 8,
  maxActiveAttempts: 1,
  maxUploadBytes: 20 * 1024 * 1024,
  maxAttachments: 10,
  contentRetentionDays: 30,
  maxBriefChars: 16_000,
  maxDelegationDepth: 1,
} as const;

/** Platform fee in basis points. This release enforces zero; any other value is refused. */
export const MARKETPLACE_FEE_BPS = 0;

export const TEST_TOKEN_LABEL = "Devnet test tokens — no monetary value";
