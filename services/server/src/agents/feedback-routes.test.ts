import { describe, expect, it } from "vitest";
import type { TeamRole } from "@kobe/db";
import { agentAccess } from "./access.js";
import { mayReadFeedbackTotals } from "./feedback-routes.js";
import type { ResolvedAgent } from "./version-routes.js";

const ME = "me";

function resolved(
  scope: "team" | "personal" | "gallery",
  ownerUserId: string | null,
  role: TeamRole,
) {
  return {
    agent: { scope, ownerUserId, id: "a" },
    location: { scope },
    access: agentAccess({ userId: ME, role }, { scope, ownerUserId }),
  } as unknown as ResolvedAgent;
}

describe("mayReadFeedbackTotals (KOBE-275)", () => {
  it.each([
    ["team", ME, "builder", true],
    ["team", "other", "builder", false],
    ["team", "other", "team_admin", true],
    ["team", ME, "member", false],
    ["team", "other", "member", false],
    ["personal", ME, "member", true],
    ["gallery", null, "team_admin", true],
    ["gallery", null, "builder", false],
    ["gallery", null, "member", false],
  ] as const)("%s agent owned by %s, caller %s → %s", (scope, owner, role, allowed) => {
    expect(mayReadFeedbackTotals(resolved(scope, owner, role), role)).toBe(allowed);
  });
});
