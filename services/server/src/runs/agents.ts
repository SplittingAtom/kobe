import { resolveDraftAgent, resolvePinnedAgent } from "../agents/versions.js";
import { readApprovalFloor, strictestApprovalMode } from "../policy/approval-floor.js";
import {
  resolveEffective,
  resolveSkills,
  type Omission,
  type SkillRef,
} from "../resolver/resolve.js";
import { agentSkills } from "@kobe/agent-file";
import { bundleRefsWithGaps } from "../skills/materialize.js";
import { runSkillRefs } from "../skills/detect.js";
import {
  buildResolveInput,
  loadRequiredSkillFacts,
  loadSkillFacts,
  loadTeamFacts,
  type SkillFacts,
} from "./resolver-input.js";
import type { AgentScope, KobeTx } from "@kobe/db";
import {
  buildRunMcp,
  connectedConnectorNames,
  loadTeamConnectorRows,
  loadUserGrantFacts,
} from "./run-mcp.js";
import type { AgentResolution, AgentResolutionInput, RunAgentResolver } from "./seams.js";

/** The skill facts of a test chat's run: its draft as the agent's only skill, nothing else. */
const onlySkillFacts = (ref: SkillRef): SkillFacts => ({
  agent: [ref],
  agentCatalog: [],
  agentOmissions: [],
  user: [],
  agentUnapproved: [],
  agentSuspended: [],
  userUnapproved: [],
  userSuspended: [],
  required: [],
  requiredOmissions: [],
  offered: [],
  offeredOmissions: [],
  blockedHashes: [],
});

/** A skill eval's baseline (KOBE-325, SK25): no Required, agent-named, offered or personal skill. */
const NO_SKILL_FACTS: SkillFacts = {
  agent: [],
  agentCatalog: [],
  agentOmissions: [],
  user: [],
  agentUnapproved: [],
  agentSuspended: [],
  userUnapproved: [],
  userSuspended: [],
  required: [],
  requiredOmissions: [],
  offered: [],
  offeredOmissions: [],
  blockedHashes: [],
};

const unavailableOmissions = (names: readonly string[]): Omission[] =>
  names.map((name) => ({ kind: "skill", name, reason: "unavailable" }));

/**
 * A run with no agent (review S6): the team's Required skills (SK27 step 1) and their notices,
 * materialized and recorded like an agent's. Empty when the team has none.
 */
async function requiredOnly(
  tx: KobeTx,
  input: AgentResolutionInput,
): Promise<Pick<Extract<AgentResolution, { ok: true }>, "config" | "omissions" | "skillRefs">> {
  const owner = { teamId: input.teamId, userId: input.ownerUserId };
  const facts = await loadRequiredSkillFacts(tx, owner.teamId, owner.userId);
  if (facts.required.length === 0 && facts.requiredOmissions.length === 0) return {};
  const resolved = resolveSkills({
    agent: {
      modelAlias: null,
      approvalMode: null,
      skills: [],
      exclusiveSkills: true,
      connectors: [],
    },
    team: {
      models: [],
      connectors: [],
      personalSkillsDisabled: false,
      requiredSkills: facts.required,
      requiredOmissions: facts.requiredOmissions,
    },
    user: { skills: [], connectedConnectors: [] },
    approvalFloor: "auto",
    blockedHashes: facts.blockedHashes,
  });
  const { refs, unavailable } = await bundleRefsWithGaps(tx, owner, resolved.skills);
  const omissions = [...resolved.omissions, ...unavailableOmissions(unavailable)];
  const skillRefs = runSkillRefs(refs, resolved.skills);
  return {
    ...(omissions.length > 0 ? { omissions } : {}),
    ...(refs.length > 0
      ? { config: { skills: refs.map((s) => s.name), skill_bundles: refs }, skillRefs }
      : {}),
  };
}

/**
 * A test thread (KOBE-85: agent set, version null; the database allows that only for `is_test`)
 * runs the agent's draft; every other thread its exact pinned version.
 */
function resolveRunAgent(
  tx: KobeTx,
  owner: { teamId: string; userId: string },
  {
    agentScope,
    agentId,
    agentVersion,
  }: { agentScope: AgentScope; agentId: string; agentVersion: number | null },
) {
  return agentVersion === null
    ? resolveDraftAgent(tx, owner, { agentScope, agentId })
    : resolvePinnedAgent(tx, owner, { agentScope, agentId, agentVersion });
}

/**
 * Run-start agent resolution (KOBE-46 seam, D19), inside the run-start transaction under the
 * thread lock: the thread's exact pinned version for its owner — never a fallback to another
 * version or the default agent (an error fails the run, `agent_unavailable`). The pinned version
 * is resolved against the team by `resolveEffective` (KOBE-75/76): the pinned model (not enabled
 * for the team: error `agent_model_not_enabled`, no fallback), the run's mode (the version's frozen
 * mode under today's site floor, only stricter), and the connectors; `omissions` lists what the
 * resolver left out. The site default agent (no pin) still gets the KOBE-46 site floor.
 * Per-call `versionAllowsCall` gating is KOBE-47.
 */
export const PINNED_AGENTS: RunAgentResolver = {
  async resolve(tx, input) {
    const floor = await readApprovalFloor(tx);
    if (input.agentId === null || input.agentScope === null) {
      return {
        ok: true,
        agent: null,
        approvalMode: strictestApprovalMode(input.approvalMode, floor),
        ...(await requiredOnly(tx, input)),
      };
    }
    const owner = { teamId: input.teamId, userId: input.ownerUserId };
    const { agentScope, agentId, agentVersion } = input;
    const pinned = await resolveRunAgent(tx, owner, { agentScope, agentId, agentVersion });
    if (!pinned.ok) {
      return {
        ok: false,
        error: { code: pinned.error, message: "The thread's agent version is not available." },
      };
    }
    const { frontmatter } = pinned.version.definition;
    const team = await loadTeamFacts(tx, input.teamId);
    // A Workbench test chat (KOBE-323) runs its draft alone: no other skill's facts are read.
    const skills = input.onlySkill
      ? onlySkillFacts(input.onlySkill.ref)
      : input.noSkills
        ? NO_SKILL_FACTS
        : await loadSkillFacts(tx, {
            teamId: input.teamId,
            userId: input.ownerUserId,
            agentSkillNames: agentSkills(frontmatter).names,
            personalSkillsDisabled: team.personalSkillsDisabled,
            // A published team version runs the local skill versions it froze (KOBE-318).
            ...(pinned.version.skillManifest
              ? { frozen: pinned.version.skillManifest.skills }
              : {}),
          });
    const connectorRows = await loadTeamConnectorRows(tx, input.teamId);
    const connectedConnectors = connectedConnectorNames(
      connectorRows,
      input.noPersonalGrants ? [] : await loadUserGrantFacts(tx, input.teamId, input.ownerUserId),
      new Date(),
    );
    const resolved = resolveEffective(
      buildResolveInput({
        connectedConnectors,
        frontmatter,
        versionMode: pinned.version.toolManifest.approval_mode.effective,
        floor,
        team,
        skills,
      }),
    );
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { value } = resolved;
    // Per-session MCP config (KOBE-111): the effective connectors with the tools the agent may see.
    const mcp = buildRunMcp(connectorRows, value.connectors, frontmatter.tools);
    const mcpServers = mcp.servers.map((s) => ({ name: s.name, connector_id: s.connector_id }));
    // Both this and `resolveRunModel` (lifecycle.ts) exist because the resolver sees aliases only:
    // `resolveRunModel` adds the gateway id/API style and the thread's choice (no resolver input).
    // Only an agent's own pin is its model; otherwise the thread's choice or the team default
    // is picked by the run start (`requestedModel`).
    const model = frontmatter.model !== undefined && value.model !== undefined;
    // Materialization list (KOBE-82), in this same transaction: the blocklist is read once more, so
    // a hash listed since the facts were loaded never reaches a sandbox. These refs are the only
    // skills the sandbox makes present; `skills` (names) always equals their names.
    // A test chat's draft bundle has no version row: its ref comes from `withDraftTests`, which
    // checked the blocklist and the scanned object in this same transaction.
    const { refs: skillBundles, unavailable } = input.onlySkill
      ? { refs: [input.onlySkill.bundle], unavailable: [] }
      : input.noSkills
        ? { refs: [], unavailable: [] }
        : await bundleRefsWithGaps(
            tx,
            { teamId: input.teamId, userId: input.ownerUserId },
            value.skills,
          );
    const omissions = [...value.omissions, ...unavailableOmissions(unavailable)];
    const config = {
      ...(pinned.version.definition.prompt.trim() === ""
        ? {}
        : { system_prompt: pinned.version.definition.prompt }),
      ...(model ? { model: { alias: value.model as string } } : {}),
      ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
      ...(skillBundles.length > 0
        ? { skills: skillBundles.map((s) => s.name), skill_bundles: skillBundles }
        : {}),
    };
    // KOBE-297: what this run.start lists, kept with the run so a SKILL.md read can be matched.
    const skillRefs = runSkillRefs(skillBundles, value.skills);
    return {
      ok: true,
      agent: {
        agentId: pinned.agent.id,
        version: pinned.version.version,
        ...(pinned.version.version === null && pinned.version.draftRevision !== null
          ? { draftRevision: pinned.version.draftRevision }
          : {}),
      },
      approvalMode: strictestApprovalMode(input.approvalMode, value.approvalMode),
      omissions,
      mcp,
      ...(skillRefs.length > 0 ? { skillRefs } : {}),
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
  },
};
