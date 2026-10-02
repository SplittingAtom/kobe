import { randomUUID } from "node:crypto";
import { teamMembers, users } from "../../schema/index.js";
import type { identity } from "../../tenancy/identity.js";
import type { ProbeFixture } from "./types.js";

export const identityFixtures: Record<(typeof identity.team)[number], ProbeFixture> = {
  team_members: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx.insert(teamMembers).values({ teamId, userId, role: "member" });
  },
};
