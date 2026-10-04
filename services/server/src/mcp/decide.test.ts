import { describe, expect, it } from "vitest";
import type { PolicyDecision } from "@kobe/protocol";
import { combineDecisions } from "./decide.js";

const reason = (
  code: "risk_read" | "risk_write" | "mode_auto_not_allowlisted" | "team_deny_rule",
) => ({ code, stage: "risk_class", message: code }) as const;
const allow: PolicyDecision = { effect: "allow", risk: "read", reasons: [reason("risk_read")] };
const ask: PolicyDecision = {
  effect: "require_approval",
  risk: "write",
  reasons: [reason("risk_write")],
  expires_at: "2026-10-03T00:00:00Z",
};
const deny: PolicyDecision = {
  effect: "deny",
  risk: "write",
  reasons: [reason("mode_auto_not_allowlisted")],
};

describe("combineDecisions (review M1)", () => {
  it("allows only when the named run and every sibling allow", () => {
    expect(combineDecisions(allow, []).effect).toBe("allow");
    expect(combineDecisions(allow, [allow, allow]).effect).toBe("allow");
  });

  it("denies whenever the named run denies, whatever the siblings say", () => {
    expect(combineDecisions(deny, [allow])).toMatchObject({ effect: "deny" });
  });

  it("needs the named run's approval when it asks, or when any sibling asks or denies", () => {
    expect(combineDecisions(ask, [allow])).toMatchObject({
      effect: "require_approval",
      reason: { code: "risk_write" },
    });
    // A laxer named run (auto, allow-listed) with a stricter sibling: approval required.
    expect(combineDecisions(allow, [ask])).toMatchObject({
      effect: "require_approval",
      reason: { code: "risk_write" },
    });
    expect(combineDecisions(allow, [deny]).effect).toBe("require_approval");
  });
});
