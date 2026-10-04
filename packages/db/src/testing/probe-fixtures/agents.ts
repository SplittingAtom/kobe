import { randomUUID } from "node:crypto";
import {
  teamAgents,
  teamAgentVersions,
  teamSkills,
  teamSkillVersions,
  users,
} from "../../schema/index.js";
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

async function probeSkill(tx: Parameters<ProbeFixture>[0], teamId: string) {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
  const [skill] = await tx
    .insert(teamSkills)
    .values({ teamId, ownerUserId: userId, slug: `probe-${userId.slice(0, 8)}`, description: "p" })
    .returning({ id: teamSkills.id });
  if (!skill) throw new Error("probe skill insert returned no row");
  return { userId, skillId: skill.id };
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
  team_skills: async (tx, teamId) => {
    await probeSkill(tx, teamId);
  },
  team_skill_versions: async (tx, teamId) => {
    const { userId, skillId } = await probeSkill(tx, teamId);
    await tx.insert(teamSkillVersions).values({
      teamId,
      skillId,
      version: 1,
      frontmatter: { name: "probe", description: "p" },
      source: "zip",
      contentHash: "0".repeat(64),
      storageKey: "probe",
      sizeBytes: 1,
      fileCount: 1,
      uncompressedBytes: 1,
      uploadedBy: userId,
    });
  },
};
