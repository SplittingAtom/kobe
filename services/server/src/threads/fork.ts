import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, threadEntries, threads, type KobeTx } from "@kobe/db";
import { projectDefaultAgent } from "../projects/run-context.js";
import { resolveAgentPin } from "../agents/versions.js";
import { recordAudit } from "../audit/record.js";
import { isModelEnabled } from "../models/team-store.js";
import { canCreateInProject } from "./references.js";
import { logger } from "../logger.js";
import { threadKey, type BlobStore } from "../retention/blobs.js";
import { createThread, findThread, type ThreadError, type Viewer } from "./repository.js";
import type { ThreadSummary } from "./schemas.js";

export type ForkResult = { ok: true; thread: ThreadSummary } | { ok: false; error: ThreadError };

type Row = {
  entryId: string;
  parentId: string | null;
  type: string;
  payload: Record<string, unknown>;
  blobRef: string | null;
  createdAt: Date;
};

interface Plan {
  readonly source: ThreadSummaryLike;
  readonly teamId: string;
  readonly newId: string;
  readonly title: string | null | undefined;
  readonly path: readonly Row[];
}
type ThreadSummaryLike = NonNullable<Awaited<ReturnType<typeof findThread>>>["thread"];

/** Runs `fn` in the viewer's team transaction (the route's `asViewer`). */
export type RunAsViewer = <T>(fn: (tx: KobeTx, viewer: Viewer) => Promise<T>) => Promise<T>;

/** The fork's own key for an offloaded body: `<prefix>teams/<t>/threads/<new>/entries/<sha256(id)>`. */
export function forkedBlobKey(prefix: string, teamId: string, threadId: string, entryId: string) {
  const name = createHash("sha256").update(entryId).digest("hex");
  return `${prefix}teams/${teamId}/threads/${threadId}/entries/${name}`;
}

/**
 * Forks a thread the viewer may read (their own, or one shared to their project: D23) into a new
 * private thread they own: the entries from the root to `entryId` (default: the leaf) are copied
 * with their ids, so the new thread continues from there. Workspace files are not copied. The
 * fork stays in the source's project when the viewer may still create in it, and pins the same
 * agent when they can still start it (else the project's or the team's default).
 *
 * Offloaded entry bodies (KOBE-236) are copied into the new thread's own key tree (S3 server-side
 * copy; deterministic keys, so a retry overwrites) before any row is written, outside every
 * transaction: plan (read) -> copy blobs -> store rows in one transaction. A source under legal
 * hold is read like any other; the copies belong to the new thread and follow its retention. If
 * the rows can't be stored the copies are deleted again. Without object storage, or when a body
 * is not in the source's tree, the fork is refused `entry_offloaded`.
 */
export async function forkThread(
  run: RunAsViewer,
  blobs: BlobStore | undefined,
  id: string,
  options: { entryId?: string | undefined; title?: string | undefined },
): Promise<ForkResult> {
  const planned = await run(async (tx, viewer) => {
    const plan = await planFork(tx, viewer, id, options);
    if (!plan.ok) return plan;
    // Nothing offloaded: plan and store in one transaction.
    if (plan.value.path.every((e) => e.blobRef === null)) {
      return { ok: true as const, done: await storeFork(tx, viewer, plan.value, new Map()) };
    }
    return { ok: true as const, plan: plan.value };
  });
  if (!planned.ok) return planned;
  if ("done" in planned) return planned.done;

  const plan = planned.plan;
  const teamId = plan.teamId;
  if (!blobs) return { ok: false, error: "entry_offloaded" };
  const copies = new Map<string, string>();
  try {
    for (const e of plan.path) {
      if (e.blobRef === null) continue;
      if (!threadKey(blobs.prefix, teamId, id, e.blobRef)) {
        await removeCopies(blobs, copies);
        return { ok: false, error: "entry_offloaded" };
      }
      const to = forkedBlobKey(blobs.prefix, teamId, plan.newId, e.entryId);
      await blobs.objects.copy(e.blobRef, to);
      copies.set(e.entryId, to);
    }
    const stored = await run((tx, viewer) => storeFork(tx, viewer, plan, copies));
    if (!stored.ok) await removeCopies(blobs, copies);
    return stored;
  } catch (err) {
    await removeCopies(blobs, copies);
    throw err;
  }
}

async function removeCopies(blobs: BlobStore, copies: ReadonlyMap<string, string>): Promise<void> {
  if (copies.size === 0) return;
  await blobs.objects
    .delete([...copies.values()])
    .catch((err: unknown) =>
      logger.warn({ err }, "could not remove blobs copied for a failed fork"),
    );
}

async function planFork(
  tx: KobeTx,
  viewer: Viewer,
  id: string,
  options: { entryId?: string | undefined; title?: string | undefined },
): Promise<{ ok: true; value: Plan } | { ok: false; error: ThreadError }> {
  const found = await findThread(tx, viewer, id);
  if (!found || found.thread.isTest) return { ok: false, error: "thread_not_found" };
  const source = found.thread;
  if (source.deletedAt) return { ok: false, error: "thread_in_trash" };

  const rows: Row[] = await tx
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
  const path: Row[] = [];
  for (let at = target ? byId.get(target) : undefined; at;) {
    path.unshift(at);
    at = at.parentId === null ? undefined : byId.get(at.parentId);
  }
  return {
    ok: true,
    value: { source, teamId: viewer.teamId, newId: randomUUID(), title: options.title, path },
  };
}

async function storeFork(
  tx: KobeTx,
  viewer: Viewer,
  plan: Plan,
  copies: ReadonlyMap<string, string>,
): Promise<ForkResult> {
  const { source, path } = plan;
  if (copies.size > 0) {
    // Time passed while the bodies were copied: the viewer must still be able to read the source.
    const again = await findThread(tx, viewer, source.id);
    if (!again || again.thread.isTest) return { ok: false, error: "thread_not_found" };
    if (again.thread.deletedAt) return { ok: false, error: "thread_in_trash" };
  }
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
    id: plan.newId,
    teamId: viewer.teamId,
    ownerUserId: viewer.userId,
    projectId,
    agent: pin.value,
    title: plan.title ?? source.title,
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
        blobRef: copies.get(e.entryId) ?? null,
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
      sourceThreadId: source.id,
      projectId,
      entries: path.length,
    },
  });
  return { ok: true, thread: { ...created, leaf_entry_id: path.at(-1)?.entryId ?? null } };
}
