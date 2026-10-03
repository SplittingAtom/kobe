import { resolvePinnedAgent } from "../agents/versions.js";
import { effectiveApprovalMode } from "../agents/manifest.js";
import { readApprovalFloor, strictestApprovalMode } from "../policy/approval-floor.js";
import type { RunAgentResolver } from "./seams.js";

/**
 * Run-start agent resolution (KOBE-46 seam, D19), inside the run-start transaction under the
 * thread lock: the thread's exact pinned version for its owner — never a fallback to another
 * version or the default agent (an error fails the run, `agent_unavailable`) — and the run's mode
 * made only stricter by the version's manifest under today's install floor
 * (`effectiveApprovalMode`). The install default agent (no pin) still gets the KOBE-46 install
 * floor. Pi config from the version (model alias, prompt, skills, connectors) and per-call
 * `versionAllowsCall` gating are KOBE-47/41.
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
    return {
      ok: true,
      agent: { agentId: pinned.agent.id, version: pinned.version.version },
      approvalMode: strictestApprovalMode(
        input.approvalMode,
        effectiveApprovalMode(pinned.version.toolManifest, floor),
      ),
    };
  },
};
