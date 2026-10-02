import { randomUUID } from "node:crypto";
import { teamAgents, users } from "../../schema/index.js";
import type { agents } from "../../tenancy/agents.js";
import type { ProbeFixture } from "./types.js";

export const agentsFixtures: Record<(typeof agents.team)[number], ProbeFixture> = {
  team_agents: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx.insert(teamAgents).values({
      teamId,
      ownerUserId: userId,
      slug: `probe-${userId.slice(0, 8)}`,
      frontmatter: { name: "Probe" },
    });
  },
};
