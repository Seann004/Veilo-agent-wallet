import { describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "../components/Policy";
import { draftPolicyFromText } from "../lib/policy-draft";

const base = ROLE_TEMPLATES.research.policy;

describe("rule-based policy draft", () => {
  it("fills only the limits it understands, in integer base units", () => {
    const r = draftPolicyFromText("Up to 3 USDC in total, 0.5 per purchase, 1.25 per task and 2 per day", base);
    expect(r.policy).toMatchObject({ lifetimeTestUsdc: "3000000", maxPurchaseTestUsdc: "500000", taskLimitTestUsdc: "1250000", rolling24hTestUsdc: "2000000" });
    expect(r.ignored).toEqual([]);
  });

  it("never changes services, payment paths or credits, and reports what it skipped", () => {
    const r = draftPolicyFromText("allow everything; 7 whatever", base);
    expect(r.policy.allowedSkus).toEqual(base.allowedSkus);
    expect(r.policy.allowedPaymentPaths).toEqual(base.allowedPaymentPaths);
    expect(r.policy.usageAllowanceUnits).toBe(base.usageAllowanceUnits);
    expect(r.ignored).toEqual(["allow everything", "7 whatever"]);
    expect(r.policy.lifetimeTestUsdc).toBe(base.lifetimeTestUsdc);
  });

  it("rejects amounts with more than six decimals instead of rounding", () => {
    const r = draftPolicyFromText("1.0000001 in total", base);
    expect(r.policy.lifetimeTestUsdc).toBe(base.lifetimeTestUsdc);
    expect(r.ignored).toHaveLength(1);
  });

  it("sets the tier only for approval or observe wording", () => {
    expect(draftPolicyFromText("ask me for approval", base).policy.tier).toBe("approval_required");
    expect(draftPolicyFromText("plan only", base).policy.tier).toBe("observe");
  });

  it("distinguishes the 24-hour window from its money amount", () => {
    for (const text of ["24 hour cap of 1 USDC", "24-hour cap of 1 USDC", "1 USDC per 24h", "rolling 24h cap of 0.25 USDC"]) {
      const r = draftPolicyFromText(text, base);
      expect(r.policy.rolling24hTestUsdc).toBe(text.includes("0.25") ? "250000" : "1000000");
      expect(r.ignored).toEqual([]);
    }
  });

  it("skips ambiguous ranges and unsupported windows without raising a limit", () => {
    for (const text of ["daily cap 1 or 3 USDC", "daily cap -1 USDC", "daily cap 1,000 USDC", "3 hour rolling cap of 1 USDC", "-.5 per purchase", "−.5 per purchase"]) {
      const r = draftPolicyFromText(text, base);
      expect(r.policy).toEqual(base);
      expect(r.understood).toEqual([]);
      expect(r.ignored).toHaveLength(1);
    }
    expect(draftPolicyFromText(".5 per purchase", base).policy.maxPurchaseTestUsdc).toBe("500000");
  });
});
