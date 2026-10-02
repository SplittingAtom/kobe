import { randomUUID } from "node:crypto";
import { teamMembers, toolRules, users } from "../../schema/index.js";
import type { policy } from "../../tenancy/policy.js";
import type { ProbeFixture } from "./types.js";

export const policyFixtures: Record<(typeof policy.team)[number], ProbeFixture> = {
  tool_rules: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx.insert(teamMembers).values({ teamId, userId, role: "member" });
    await tx.insert(toolRules).values([
      { teamId, scope: "team", effect: "deny", toolGlob: "bash", createdBy: userId },
      { teamId, scope: "user", userId, effect: "allow", toolGlob: "read", createdBy: userId },
    ]);
  },
};
