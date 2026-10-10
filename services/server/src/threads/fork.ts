import { and, asc, eq, threadEntries, threads, type KobeTx } from "@kobe/db";
import { projectDefaultAgent } from "../projects/run-context.js";
import { resolveAgentPin } from "../agents/versions.js";
import { recordAudit } from "../audit/record.js";
import { isModelEnabled } from "../models/team-store.js";
import { canCreateInProject } from "./references.js";
import { createThread, findThread, type ThreadError, type Viewer } from "./repository.js";
import type { ThreadSummary } from "./schemas.js";

export type ForkResult = { ok: true; thread: ThreadSummary } | { ok: false; error: ThreadError };

/**
 * Forks a thread the viewer may read (their own, or one shared to their project: D23) into a new
 * private thread they own: the entries from the root to `entryId` (default: the leaf) are copied
 * with their ids, so the new thread continues from there. Workspace files are not copied. The
 * fork stays in the source's project when the viewer may still create in it, and pins the same
 * agent when they can still start it (else the project's or the team's default). Offloaded entry
 * bodies live under the source thread's blob tree and are not shared: such a path is refused.
 */
export async function forkThread(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  options: { entryId?: string | undefined; title?: string | undefined },
): Promise<ForkResult> {
  const found = await findThread(tx, viewer, id);
  if (!found || found.thread.isTest) return { ok: false, error: "thread_not_found" };
  const source = found.thread;
  if (source.deletedAt) return { ok: false, error: "thread_in_trash" };

  const rows = await tx
    .select({
      entryId: threadEntries.entryId,
      parentId: threadEntries.parentId,
      type: threadEntries.type,
      payload: threadEntries.payload,
      blobRef: threadEntries.blobRef,
      createdAt: threadEntries.createdAt,
    })
    .from(threadEntries)
    .where(and(eq(threadEntries.teamId, viewer.teamId), eq(threadEntries.threadId, id)))
    .orderBy(asc(threadEntries.seq));
  const byId = new Map(rows.map((r) => [r.entryId, r]));
  const target = options.entryId ?? source.leafEntryId;
  if (options.entryId !== undefined && !byId.has(options.entryId)) {
    return { ok: false, error: "entry_not_found" };
  }
  const path: typeof rows = [];
  for (let at = target ? byId.get(target) : undefined; at;) {
    path.unshift(at);
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }
  if (path.some((e) => e.blobRef !== null)) return { ok: false, error: "entry_offloaded" };

  const projectId =
    source.projectId !== null && (await canCreateInProject(tx, viewer, source.projectId))
      ? source.projectId
      : null;
  let pin = await resolveAgentPin(tx, viewer, source.agentId);
  if (!pin.ok) {
    pin = await resolveAgentPin(tx, viewer, await projectDefaultAgent(tx, viewer, projectId));
    if (!pin.ok) pin = { ok: true, value: null };
  }
  const model =
    source.modelAlias !== null && (await isModelEnabled(tx, viewer.teamId, source.modelAlias))
      ? source.modelAlias
      : null;
  const created = await createThread(tx, {
    teamId: viewer.teamId,
    ownerUserId: viewer.userId,
    projectId,
    agent: pin.value,
    title: options.title ?? source.title,
    modelAlias: model,
  });
  if (path.length > 0) {
    await tx.insert(threadEntries).values(
      path.map((e) => ({
        teamId: viewer.teamId,
        threadId: created.thread_id,
        entryId: e.entryId,
        parentId: e.parentId,
        type: e.type,
        payload: e.payload,
        createdAt: e.createdAt,
      })),
    );
    await tx
      .update(threads)
      .set({ leafEntryId: path[path.length - 1]?.entryId ?? null })
      .where(and(eq(threads.teamId, viewer.teamId), eq(threads.id, created.thread_id)));
  }
  await recordAudit(tx, {
    action: "thread.forked",
    teamId: viewer.teamId,
    target: {
      threadId: created.thread_id,
      sourceThreadId: id,
      projectId,
      entries: path.length,
    },
  });
  return { ok: true, thread: { ...created, leaf_entry_id: path.at(-1)?.entryId ?? null } };
}
