import { randomUUID } from "node:crypto";
import { egressDomains, teamEgress, teamMembers, toolRules, users } from "../../schema/index.js";
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
  team_egress: async (tx, teamId) => {
    const userId = randomUUID();
    const domain = `probe-${teamId.slice(0, 8)}.example.com`;
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx.insert(egressDomains).values({ domain, inCeiling: true }).onConflictDoNothing();
    await tx.insert(teamEgress).values({ teamId, domain, enabledBy: userId });
  },
};
