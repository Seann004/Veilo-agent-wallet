import { parseUsdcInput } from "./format";
import type { AgentPolicyInput } from "../components/Policy";

export interface PolicyDraftResult {
  policy: AgentPolicyInput;
  understood: string[];
  ignored: string[];
}

type AmountField = "lifetimeTestUsdc" | "rolling24hTestUsdc" | "maxPurchaseTestUsdc" | "taskLimitTestUsdc";

const FIELD_KEYWORDS: Array<[AmountField, string, RegExp]> = [
  ["maxPurchaseTestUsdc", "per-purchase limit", /per[- ]purchase|each purchase|single purchase|per payment|max(?:imum)? purchase/],
  ["taskLimitTestUsdc", "per-task budget", /per[- ]task|each task|task budget/],
  ["rolling24hTestUsdc", "rolling 24 h cap", /24[- ]?h(?:ours?)?\b|per day|a day|daily|rolling/],
  ["lifetimeTestUsdc", "lifetime allowance", /lifetime|in total|total|overall|altogether/],
];

/**
 * Deterministic, rule-based reading of an owner's description into structured limits. It is not a
 * model and it only returns a draft: nothing is saved or activated until the owner reviews the
 * form and uses the normal create and activate steps. Services and payment paths are never
 * changed from the template.
 */
export function draftPolicyFromText(text: string, base: AgentPolicyInput): PolicyDraftResult {
  const policy: AgentPolicyInput = { ...base };
  const understood: string[] = [];
  const ignored: string[] = [];
  const clauses = text
    .toLowerCase()
    .split(/[;\n]|(?<!\d),|,(?!\d)|\.(?!\d)|\band\b/)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    if (/approval|ask me|confirm with me/.test(clause)) {
      policy.tier = "approval_required";
      understood.push("authority tier: approval required");
      continue;
    }
    if (/observe only|plan only|read[- ]only/.test(clause)) {
      policy.tier = "observe";
      understood.push("authority tier: observe");
      continue;
    }
    // Period lengths describe the window, never its spending allowance.
    const amountClause = clause.replace(/\b24[- ]?h(?:ours?)?\b/g, "");
    const numbers = [...amountClause.matchAll(/\d+(?:\.\d+)?|\.\d+/g)];
    // Ranges, negative amounts and other multi-number clauses need an owner decision.
    if (numbers.length !== 1 || /[-−]\s*\$?\s*(?:\d|\.\d)/.test(amountClause)) {
      ignored.push(clause);
      continue;
    }
    const rawAmount = numbers[0]![0];
    const amount = rawAmount.startsWith(".") ? `0${rawAmount}` : rawAmount;
    const hit = FIELD_KEYWORDS.find(([, , re]) => re.test(clause));
    const base6 = parseUsdcInput(amount);
    if (!hit || base6 === null) {
      ignored.push(clause);
      continue;
    }
    policy[hit[0]] = base6;
    understood.push(`${hit[1]}: ${amount} test-USDC`);
  }
  return { policy, understood, ignored };
}
