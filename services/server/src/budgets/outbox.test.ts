import { describe, expect, it } from "vitest";
import { budgetAlertPath } from "./outbox.js";

describe("budget email links (KOBE-257)", () => {
  it("sends each recipient to a page they can open", () => {
    expect(budgetAlertPath("install", false)).toBe("/admin/site/usage");
    expect(budgetAlertPath("team", false)).toBe("/admin/team/budgets");
    // A team admin told about a member's budget manages it in the team console…
    expect(budgetAlertPath("user", false)).toBe("/admin/team/budgets");
    // …the member about their own budget sees it in the chat (no admin console access).
    expect(budgetAlertPath("user", true)).toBe("/");
  });
});
