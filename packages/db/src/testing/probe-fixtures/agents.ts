import { randomUUID } from "node:crypto";
import { teamAgents, teamAgentVersions, users } from "../../schema/index.js";
import type { agents } from "../../tenancy/agents.js";
import type { ProbeFixture } from "./types.js";

async function probeAgent(tx: Parameters<ProbeFixture>[0], teamId: string) {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
  const [agent] = await tx
    .insert(teamAgents)
    .values({
      teamId,
      ownerUserId: userId,
      slug: `probe-${userId.slice(0, 8)}`,
      frontmatter: { name: "Probe" },
    })
    .returning({ id: teamAgents.id });
  if (!agent) throw new Error("probe agent insert returned no row");
  return { userId, agentId: agent.id };
}

export const agentsFixtures: Record<(typeof agents.team)[number], ProbeFixture> = {
  team_agents: async (tx, teamId) => {
    await probeAgent(tx, teamId);
  },
  team_agent_versions: async (tx, teamId) => {
    const { userId, agentId } = await probeAgent(tx, teamId);
    await tx.insert(teamAgentVersions).values({
      teamId,
      agentId,
      version: 1,
      frontmatter: { name: "Probe" },
      prompt: "",
      toolManifest: {},
      publishedBy: userId,
      draftRevision: 1,
    });
  },
};
