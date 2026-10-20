import { ACTIVE_RUN_STATUSES, and, eq, isNull, threads, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { resolveAgentPin } from "../agents/versions.js";
import {
  hasRunIn,
  lockForChange,
  summarizeOne,
  summaryColumns,
  type ThreadResult,
  type Viewer,
} from "./repository.js";

/**
 * `POST /v1/threads/:id/agent` (KOBE-458 ac-3): an agentless thread (one a rail launch started
 * before KOBE-458, or a plain chat) takes the agent its owner picks in the composer, pinned to its
 * current published version (D19), checked exactly as `POST /v1/threads` checks `agent_id`
 * (`resolveAgentPin`: visible to the owner, active in this team, not archived, published). Only
 * once: a thread that already has an agent keeps it (`agent_already_chosen`; versions move with
 * `/agent-version`). Refused while a run is active. The next run resolves the agent like any
 * thread's: its tools, the team's exposure and the thread's connectors-off all still apply.
 */
export async function chooseThreadAgent(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  agentId: string,
): Promise<ThreadResult> {
  const locked = await lockForChange(tx, viewer, id);
  if (!locked.ok) return locked;
  const thread = locked.thread;
  if (thread.deletedAt) return { ok: false, error: "thread_in_trash" };
  if (thread.isTest) return { ok: false, error: "test_thread" };
  if (thread.agentId !== null) return { ok: false, error: "agent_already_chosen" };
  if (await hasRunIn(tx, viewer, id, ACTIVE_RUN_STATUSES)) {
    return { ok: false, error: "thread_busy" };
  }
  const pin = await resolveAgentPin(tx, viewer, agentId);
  if (!pin.ok) return pin;
  if (pin.value === null) return { ok: false, error: "agent_not_found" };
  const { agentScope, agentVersion } = pin.value;
  const [row] = await tx
    .update(threads)
    .set({ agentScope, agentId: pin.value.agentId, agentVersion })
    .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, id), isNull(threads.agentId)))
    .returning(summaryColumns);
  if (!row) throw new Error("thread update returned no row");
  await recordAudit(tx, {
    action: "thread.agent_chosen",
    teamId: viewer.teamId,
    target: { threadId: id, agentId: pin.value.agentId, scope: agentScope, version: agentVersion },
  });
  return { ok: true, thread: await summarizeOne(tx, viewer, row) };
}
