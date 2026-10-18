import { describe, expect, it } from "vitest";
import { plainFailure, saveFailureText } from "../src/roles/custom";

describe("plain failure reasons", () => {
  it("names the real cause in the owner's words", () => {
    expect(plainFailure(["This agent's spending limits do not allow the Analyze service, so it could not do the work itself."])).toMatch(/not allowed to buy the AI work/);
    expect(plainFailure(["The analysis did not return a result (not purchased (BUDGET_EXCEEDED: agent lifetime allocation would be exceeded))."])).toMatch(/spending limit/);
    expect(plainFailure(["Purchase p1 was still settling when the task stopped waiting; control keeps reconciling it."])).toMatch(/Still working/);
    expect(plainFailure(["The swap did not go through (Rejected)."])).toMatch(/swap didn't go through/);
    expect(plainFailure(["The analysis did not return a result (not purchased (NOTE_PENDING: no approved spendable pool note covers this purchase))."])).toMatch(/Add funds in Wallet/);
    // A note that merely mentions a budget is not read as running out of money.
    expect(plainFailure(["Owner asked about the marketing budget."])).toMatch(/couldn't finish this job/);
  });

  it("explains a refused save instead of a bare failure", () => {
    expect(saveFailureText({ status: 403, body: { error: { code: "POLICY_DENIED", message: "brief references a URL that is not purchased evidence" } } })).toBe(
      "Couldn't save the answer: it cited a page the agent wasn't cleared to read.",
    );
    expect(saveFailureText({ status: 0, body: { error: { code: "BUDGET_EXCEEDED", message: "task tool-call limit reached" } } })).toMatch(/step limit/);
    expect(saveFailureText({ status: 500 })).toBe("Couldn't save the answer (HTTP 500).");
  });
});
