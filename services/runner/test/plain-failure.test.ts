import { describe, expect, it } from "vitest";
import { plainFailure } from "../src/roles/custom";

describe("plain failure reasons", () => {
  it("names the real cause in the owner's words", () => {
    expect(plainFailure(["This agent's spending limits do not allow the Analyze service, so it could not do the work itself."])).toMatch(/not allowed to buy the AI work/);
    expect(plainFailure(["The analysis did not return a result (not purchased (BUDGET_EXCEEDED: agent lifetime allocation would be exceeded))."])).toMatch(/spending limit/);
    expect(plainFailure(["Purchase p1 was still settling when the task stopped waiting; control keeps reconciling it."])).toMatch(/Still working/);
    expect(plainFailure(["The swap did not go through (Rejected)."])).toMatch(/swap didn't go through/);
    // A note that merely mentions a budget is not read as running out of money.
    expect(plainFailure(["Owner asked about the marketing budget."])).toMatch(/couldn't finish this job/);
  });
});
