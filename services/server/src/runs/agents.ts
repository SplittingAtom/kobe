import { resolveDraftAgent, resolvePinnedAgent } from "../agents/versions.js";
import { readApprovalFloor, strictestApprovalMode } from "../policy/approval-floor.js";
import { resolveEffective } from "../resolver/resolve.js";
import { agentSkills } from "@kobe/agent-file";
import { bundleRefsFor } from "../skills/materialize.js";
import { buildResolveInput, loadSkillFacts, loadTeamFacts } from "./resolver-input.js";
import type { AgentScope, KobeTx } from "@kobe/db";
import type { RunAgentResolver } from "./seams.js";

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
 * mode under today's install floor, only stricter), and the connectors; `omissions` lists what the
 * resolver left out. The install default agent (no pin) still gets the KOBE-46 install floor.
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
    const skills = await loadSkillFacts(tx, {
      teamId: input.teamId,
      userId: input.ownerUserId,
      agentSkillNames: agentSkills(frontmatter).names,
      personalSkillsDisabled: team.personalSkillsDisabled,
    });
    const resolved = resolveEffective(
      buildResolveInput({
        frontmatter,
        versionMode: pinned.version.toolManifest.approval_mode.effective,
        floor,
        team,
        skills,
      }),
    );
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { value } = resolved;
    const ids = new Map(team.connectors.map((c) => [c.name, c.id]));
    const mcpServers = value.connectors.flatMap((name) => {
      const id = ids.get(name);
      return id === undefined ? [] : [{ name, connector_id: id }];
    });
    // Both this and `resolveRunModel` (lifecycle.ts) exist because the resolver sees aliases only:
    // `resolveRunModel` adds the gateway id/API style and the thread's choice (no resolver input).
    // Only an agent's own pin is its model; otherwise the thread's choice or the team default
    // is picked by the run start (`requestedModel`).
    const model = frontmatter.model !== undefined && value.model !== undefined;
    // Materialization list (KOBE-82), in this same transaction: the blocklist is read once more, so
    // a hash listed since the facts were loaded never reaches a sandbox. These refs are the only
    // skills the sandbox makes present; `skills` (names) always equals their names.
    const skillBundles = await bundleRefsFor(
      tx,
      { teamId: input.teamId, userId: input.ownerUserId },
      value.skills,
    );
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
    return {
      ok: true,
      agent: { agentId: pinned.agent.id, version: pinned.version.version },
      approvalMode: strictestApprovalMode(input.approvalMode, value.approvalMode),
      omissions: value.omissions,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
  },
};
