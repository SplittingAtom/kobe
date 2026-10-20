import { and, eq, isNull, threads, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { resolveAgentPin } from "../agents/versions.js";
import {
  hasRunIn,
  lockForChange,
  PENDING_RUN_STATUSES,
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
 * `/agent-version`). Only a plain conversation (review LOW-1): not in Trash, not archived, not a
 * builder test, Workbench test chat or eval thread (`test_thread`), not one a schedule started
 * (`scheduled_thread`: its schedule decides the agent). Refused while a run is queued or active
 * (LOW-2: a message written for a plain chat must not run with the agent). The next run resolves
 * the agent like any thread's: its tools, the team's exposure and connectors-off still apply.
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
  if (thread.archivedAt) return { ok: false, error: "thread_archived" };
  if (thread.isTest || thread.skillTest || (await isEvalThread(tx, viewer.teamId, id))) {
    return { ok: false, error: "test_thread" };
  }
  if (thread.scheduleId) return { ok: false, error: "scheduled_thread" };
  if (thread.agentId !== null) return { ok: false, error: "agent_already_chosen" };
  if (await hasRunIn(tx, viewer, id, PENDING_RUN_STATUSES)) {
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

async function isEvalThread(tx: KobeTx, teamId: string, id: string): Promise<boolean> {
  const [row] = await tx
    .select({ skillEval: threads.skillEval })
    .from(threads)
    .where(and(eq(threads.teamId, teamId), eq(threads.id, id)));
  return row?.skillEval === true;
}
