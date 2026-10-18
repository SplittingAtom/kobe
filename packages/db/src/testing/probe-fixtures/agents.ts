import { randomUUID } from "node:crypto";
import {
  memberSkillEnablements,
  registrySkills,
  registryVersions,
  teamMembers,
  teamSkillBlocks,
  teamSkillInstalls,
  teamSkillOptouts,
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

/** A catalog skill with one approved version (site-wide rows, KOBE-311). */
async function probeCatalogSkill(tx: Parameters<ProbeFixture>[0]) {
  const userId = randomUUID();
  await tx.insert(users).values({ id: userId, name: "Probe", email: `${userId}@probe.test` });
  const [skill] = await tx
    .insert(registrySkills)
    .values({ name: `probe-${userId.slice(0, 8)}`, summary: "Probe." })
    .returning({ id: registrySkills.id });
  if (!skill) throw new Error("probe catalog skill insert returned no row");
  const [version] = await tx
    .insert(registryVersions)
    .values({
      skillId: skill.id,
      semver: "1.0.0",
      seq: 1,
      runtimeHash: "0".repeat(64),
      packageHash: "0".repeat(64),
      manifest: {},
      provenance: {},
      source: {},
      scan: {},
      verdict: "pass",
      state: "approved",
      submittedBy: userId,
      reviewedBy: userId,
      approvedAt: new Date(),
    })
    .returning({ id: registryVersions.id });
  if (!version) throw new Error("probe catalog version insert returned no row");
  return { userId, skillId: skill.id, versionId: version.id };
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
      semver: "0.1.0",
      seq: 1,
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
      semver: "0.1.0",
      seq: 1,
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
  team_skill_installs: async (tx, teamId) => {
    const { userId, skillId, versionId } = await probeCatalogSkill(tx);
    await tx.insert(teamSkillInstalls).values({
      teamId,
      skillId,
      versionId,
      pinMode: "within_major",
      access: "default_on",
      installedBy: userId,
    });
  },
  team_skill_optouts: async (tx, teamId) => {
    const { userId, skillId } = await probeCatalogSkill(tx);
    await tx.insert(teamSkillOptouts).values({ teamId, skillId, optedOutBy: userId });
  },
  team_skill_blocks: async (tx, teamId) => {
    const { userId, skillId } = await probeCatalogSkill(tx);
    await tx.insert(teamSkillBlocks).values({ teamId, skillId, blockedBy: userId });
  },
  member_skill_enablements: async (tx, teamId) => {
    const { userId, skillId, versionId } = await probeCatalogSkill(tx);
    await tx.insert(teamMembers).values({ teamId, userId, role: "member" });
    await tx.insert(memberSkillEnablements).values({
      teamId,
      userId,
      skillRef: { kind: "catalog", skillId },
      enabled: true,
      versionId,
      pinMode: "pinned",
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
