import { randomUUID } from "node:crypto";
import {
  agentEvalCaseHistory,
  agentEvalCases,
  orbitEvals,
  teamAgents,
  teamEvalSettings,
  teamAgentSuspensions,
  teamAgentVersions,
  teamSkillReviews,
  teamSkillSettings,
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
  team_agent_suspensions: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx.insert(teamAgentSuspensions).values({
      teamId,
      agentId: randomUUID(),
      agentScope: "personal",
      suspendedBy: userId,
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
  team_skill_reviews: async (tx, teamId) => {
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
    await tx.insert(teamSkillReviews).values({
      teamId,
      skillId,
      version: 1,
      scope: "team",
      slug: "probe",
      contentHash: "0".repeat(64),
      flagged: false,
      findings: [],
      scripts: [],
      skipped: [],
    });
  },
  team_skill_settings: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx.insert(teamSkillSettings).values({ teamId, updatedBy: userId });
  },
  team_eval_settings: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx.insert(teamEvalSettings).values({ teamId, updatedBy: userId });
  },
  orbit_evals: async (tx, teamId) => {
    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
    await tx.insert(orbitEvals).values({
      teamId,
      agentId: randomUUID(),
      agentScope: "team",
      agentSlug: "probe",
      requestedBy: userId,
      draftRevision: 1,
      definition: { frontmatter: { name: "Probe" }, prompt: "" },
      model: "probe/model",
      threshold: 0.2,
      // An eval with a frozen shared case (KOBE-276).
      caseIds: [randomUUID()],
    });
  },
  agent_eval_cases: async (tx, teamId) => {
    // An accepted shared case of a team agent (KOBE-276), by its sharer.
    const { userId, agentId } = await probeAgent(tx, teamId);
    await tx.insert(agentEvalCases).values({
      teamId,
      userId,
      agentScope: "team",
      agentId,
      agentVersion: 1,
      content: { prompt: "probe prompt", answer: "probe answer" },
      status: "accepted",
      expectedBehaviour: "probe expected",
      reviewedAt: new Date(),
    });
  },
  agent_eval_case_history: async (tx, teamId) => {
    // A withdrawn case kept for a hold (KOBE-276); written here directly, as the trigger would.
    const { userId, agentId } = await probeAgent(tx, teamId);
    await tx.insert(agentEvalCaseHistory).values({
      teamId,
      caseId: randomUUID(),
      userId,
      agentScope: "team",
      agentId,
      content: { prompt: "probe kept prompt" },
      status: "open",
      sharedAt: new Date(),
    });
  },
};
