import { resolvePinnedAgent } from "../agents/versions.js";
import { readApprovalFloor, strictestApprovalMode } from "../policy/approval-floor.js";
import { resolveEffective } from "../resolver/resolve.js";
import { buildResolveInput, loadTeamFacts } from "./resolver-input.js";
import type { RunAgentResolver } from "./seams.js";

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
    if (input.agentId === null || input.agentVersion === null || input.agentScope === null) {
      return {
        ok: true,
        agent: null,
        approvalMode: strictestApprovalMode(input.approvalMode, floor),
      };
    }
    const pinned = await resolvePinnedAgent(
      tx,
      { teamId: input.teamId, userId: input.ownerUserId },
      { agentScope: input.agentScope, agentId: input.agentId, agentVersion: input.agentVersion },
    );
    if (!pinned.ok) {
      return {
        ok: false,
        error: { code: pinned.error, message: "The thread's agent version is not available." },
      };
    }
    const { frontmatter } = pinned.version.definition;
    const team = await loadTeamFacts(tx, input.teamId);
    const resolved = resolveEffective(
      buildResolveInput({
        frontmatter,
        versionMode: pinned.version.toolManifest.approval_mode.effective,
        floor,
        team,
      }),
    );
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { value } = resolved;
    const ids = new Map(team.connectors.map((c) => [c.name, c.id]));
    const mcpServers = value.connectors.flatMap((name) => {
      const id = ids.get(name);
      return id === undefined ? [] : [{ name, connector_id: id }];
    });
    // Only an agent's own pin is its model; otherwise the thread's choice or the team default
    // is picked by the run start (`requestedModel`).
    const model = frontmatter.model !== undefined && value.model !== undefined;
    const config = {
      ...(model ? { model: { alias: value.model as string } } : {}),
      ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
      ...(value.skills.length > 0 ? { skills: value.skills.map((s) => s.name) } : {}),
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
