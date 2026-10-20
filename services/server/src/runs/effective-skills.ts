import type { AgentScope, KobeTx } from "@kobe/db";
import type { RunAgentResolver } from "./seams.js";

/** No run yet: the resolver reads no run, it only needs an id. */
const NO_RUN = "00000000-0000-4000-8000-000000000000";

export interface SkillsFor {
  readonly teamId: string;
  /** The thread's owner, or the member about to start one. */
  readonly ownerUserId: string;
  /** The thread; a nil id for a conversation not started yet (nothing turned off). */
  readonly threadId: string;
  readonly agentScope: AgentScope | null;
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  readonly skillTest?: boolean | undefined;
  readonly skillDraftId?: string | null | undefined;
  readonly skillEval?: boolean | undefined;
}

/**
 * The skills a run here would load (KOBE-451): the run-start resolver's own effective set (team
 * installs, the agent's, the member's adds and personal skills, minus blocked ones), read in the
 * caller's transaction. The composer lists these, and a picked skill outside them is refused.
 * Empty when the resolution fails (the run would not start either).
 */
export async function effectiveSkillNames(
  tx: KobeTx,
  agents: RunAgentResolver,
  at: SkillsFor,
): Promise<string[]> {
  const resolved = await agents
    .resolve(tx, {
      teamId: at.teamId,
      ownerUserId: at.ownerUserId,
      threadId: at.threadId,
      runId: NO_RUN,
      trigger: "user",
      agentScope: at.agentScope,
      agentId: at.agentId,
      agentVersion: at.agentVersion,
      approvalMode: "ask-on-write",
      ...(at.skillTest ? { skillTest: { draftId: at.skillDraftId ?? null } } : {}),
      ...(at.skillEval ? { skillEval: true as const } : {}),
    })
    .catch(() => ({ ok: false as const }));
  return resolved.ok ? [...(resolved.config?.skills ?? [])] : [];
}

export const NIL_THREAD = "00000000-0000-0000-0000-000000000000";
