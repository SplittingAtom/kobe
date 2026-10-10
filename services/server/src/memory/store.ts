import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  MEMORY_FILE_MAX_BYTES,
  MEMORY_INDEX_FILE,
  MEMORY_INDEX_MAX_LINES,
  type MemoryScope,
  type MemoryWriteMode,
} from "@kobe/protocol";
import { and, asc, desc, eq, isNull, memoryDocVersions, memoryDocs, type KobeTx } from "@kobe/db";
import type { BlobStore } from "../retention/blobs.js";
import { memoryBlobKey } from "./keys.js";

/**
 * Memory repository and write path (KOBE-155, spec D24). Everything runs in the caller's `withTeam`
 * transaction; every query also names the team. Content lives in the object store, one immutable
 * object per version (`memoryBlobKey`); Postgres holds pointers (`memory_docs`,
 * `memory_doc_versions`). Authorization (owner-only personal memory, project membership) is the
 * caller's: functions here take an already-resolved {@link MemoryTarget} or doc.
 *
 * A write locks the doc row (`FOR UPDATE`), uploads the new object, then inserts the version row
 * and moves `current_version`; an upload that fails throws {@link MemoryStorageError} so the
 * transaction rolls back whole. The version key is deterministic, so an object orphaned by a later
 * rollback is simply overwritten by the next write of that version.
 */

export type MemoryTarget =
  | { readonly scope: "user"; readonly ownerUserId: string }
  | { readonly scope: "project"; readonly projectId: string };

export interface MemoryActor {
  readonly kind: "user" | "agent";
  readonly userId: string | null;
  readonly runId?: string;
  readonly toolCallId?: string;
}

export class MemoryStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MemoryStorageError";
  }
}

export type WriteFailure =
  | { readonly ok: false; readonly code: "too_large" | "index_full"; readonly message: string }
  | {
      readonly ok: false;
      readonly code: "version_conflict";
      readonly message: string;
      readonly currentVersion: number;
    };

export interface WriteSuccess {
  readonly ok: true;
  readonly docId: string;
  readonly version: number;
  readonly previousVersion?: number;
  readonly sizeBytes: number;
}

export interface WriteInput {
  readonly path: string;
  readonly content: string;
  readonly mode?: MemoryWriteMode;
  /** Refuse unless the doc is at this version (0 = does not exist). */
  readonly expectedVersion?: number;
}

export interface DocRow {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly ownerUserId: string | null;
  readonly projectId: string | null;
  readonly path: string;
  readonly currentVersion: number;
  readonly deletedAt: Date | null;
  readonly updatedAt: Date;
}

const DOC_COLUMNS = {
  id: memoryDocs.id,
  scope: memoryDocs.scope,
  ownerUserId: memoryDocs.ownerUserId,
  projectId: memoryDocs.projectId,
  path: memoryDocs.path,
  currentVersion: memoryDocs.currentVersion,
  deletedAt: memoryDocs.deletedAt,
  updatedAt: memoryDocs.updatedAt,
};

export const lineCount = (s: string): number => (s === "" ? 0 : s.split("\n").length);

const targetWhere = (teamId: string, target: MemoryTarget, path: string) =>
  target.scope === "user"
    ? and(
        eq(memoryDocs.teamId, teamId),
        eq(memoryDocs.scope, "user"),
        eq(memoryDocs.ownerUserId, target.ownerUserId),
        eq(memoryDocs.path, path),
      )
    : and(
        eq(memoryDocs.teamId, teamId),
        eq(memoryDocs.scope, "project"),
        eq(memoryDocs.projectId, target.projectId),
        eq(memoryDocs.path, path),
      );

async function lockByTarget(
  tx: KobeTx,
  teamId: string,
  target: MemoryTarget,
  path: string,
): Promise<DocRow | undefined> {
  const [row] = await tx
    .select(DOC_COLUMNS)
    .from(memoryDocs)
    .where(targetWhere(teamId, target, path))
    .for("update");
  return row as DocRow | undefined;
}

/** The doc by id (soft-deleted included), unlocked. Access is checked by the caller. */
export async function findDoc(
  tx: KobeTx,
  teamId: string,
  id: string,
  lock = false,
): Promise<DocRow | undefined> {
  const q = tx
    .select(DOC_COLUMNS)
    .from(memoryDocs)
    .where(and(eq(memoryDocs.teamId, teamId), eq(memoryDocs.id, id)));
  const [row] = await (lock ? q.for("update") : q);
  return row as DocRow | undefined;
}

async function putObject(blobs: BlobStore, key: string, bytes: Buffer): Promise<void> {
  try {
    await blobs.objects.put(key, Readable.from([bytes]), bytes.length);
  } catch (err) {
    throw new MemoryStorageError("memory content could not be stored", { cause: err });
  }
}

/** The bytes of one version; null when the object is gone. */
export async function readVersionContent(
  blobs: BlobStore,
  blobRef: string,
): Promise<string | null> {
  let object;
  try {
    object = await blobs.objects.get(blobRef);
  } catch (err) {
    throw new MemoryStorageError("memory content could not be read", { cause: err });
  }
  if (!object) return null;
  if (object.size > MEMORY_FILE_MAX_BYTES) {
    object.body.destroy();
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

async function versionRow(tx: KobeTx, teamId: string, docId: string, version: number) {
  const [row] = await tx
    .select()
    .from(memoryDocVersions)
    .where(
      and(
        eq(memoryDocVersions.teamId, teamId),
        eq(memoryDocVersions.docId, docId),
        eq(memoryDocVersions.version, version),
      ),
    );
  return row;
}

/** Locks the doc for the target, creating it (version 1 pending) when there is none. */
async function lockOrCreate(
  tx: KobeTx,
  teamId: string,
  target: MemoryTarget,
  path: string,
): Promise<{ doc: DocRow; created: boolean }> {
  const existing = await lockByTarget(tx, teamId, target, path);
  if (existing) return { doc: existing, created: false };
  const id = randomUUID();
  const [inserted] = await tx
    .insert(memoryDocs)
    .values({
      teamId,
      id,
      scope: target.scope,
      ownerUserId: target.scope === "user" ? target.ownerUserId : null,
      projectId: target.scope === "project" ? target.projectId : null,
      path,
      currentVersion: 1,
    })
    .onConflictDoNothing()
    .returning(DOC_COLUMNS);
  if (inserted) return { doc: inserted as DocRow, created: true };
  // A concurrent insert of the same path committed first: lock and use that row.
  const doc = await lockByTarget(tx, teamId, target, path);
  if (!doc) throw new Error("memory doc vanished after insert");
  return { doc, created: false };
}

/** Writes a new version (`replace` by default, or `append` to the current content). */
export async function writeMemory(
  tx: KobeTx,
  blobs: BlobStore,
  teamId: string,
  target: MemoryTarget,
  input: WriteInput,
  actor: MemoryActor,
): Promise<WriteSuccess | WriteFailure> {
  const { doc, created } = await lockOrCreate(tx, teamId, target, input.path);
  const live = !created && doc.deletedAt === null;
  const current = live ? doc.currentVersion : 0;
  if (input.expectedVersion !== undefined && input.expectedVersion !== current) {
    return {
      ok: false,
      code: "version_conflict",
      message: "The file changed since you opened it.",
      currentVersion: current,
    };
  }
  let content = input.content;
  if (input.mode === "append" && live) {
    const prev = await versionRow(tx, teamId, doc.id, doc.currentVersion);
    const existing = prev ? await readVersionContent(blobs, prev.blobRef) : null;
    if (existing === null) throw new MemoryStorageError("current memory content is unavailable");
    content =
      existing === "" || existing.endsWith("\n") ? existing + content : `${existing}\n${content}`;
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > MEMORY_FILE_MAX_BYTES) {
    return {
      ok: false,
      code: "too_large",
      message: `A memory file is at most ${MEMORY_FILE_MAX_BYTES} bytes.`,
    };
  }
  if (input.path === MEMORY_INDEX_FILE && lineCount(content) > MEMORY_INDEX_MAX_LINES) {
    return {
      ok: false,
      code: "index_full",
      message: `${MEMORY_INDEX_FILE} is at most ${MEMORY_INDEX_MAX_LINES} lines.`,
    };
  }
  // A created doc (or one without versions) starts at 1; otherwise one past the newest.
  const version = created ? 1 : doc.currentVersion + 1;
  const blobRef = memoryBlobKey(blobs.prefix, teamId, doc.id, version);
  await putObject(blobs, blobRef, bytes);
  await tx.insert(memoryDocVersions).values({
    teamId,
    docId: doc.id,
    version,
    blobRef,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    actorKind: actor.kind,
    actorUserId: actor.userId,
    runId: actor.runId ?? null,
    toolCallId: actor.toolCallId ?? null,
  });
  await tx
    .update(memoryDocs)
    .set({ currentVersion: version, deletedAt: null, updatedAt: new Date() })
    .where(and(eq(memoryDocs.teamId, teamId), eq(memoryDocs.id, doc.id)));
  return {
    ok: true,
    docId: doc.id,
    version,
    ...(live ? { previousVersion: doc.currentVersion } : {}),
    sizeBytes: bytes.length,
  };
}

export type RestoreResult =
  | {
      readonly ok: true;
      readonly version: number;
      readonly fromVersion: number;
      readonly revived: boolean;
    }
  | { readonly ok: false; readonly code: "not_found" };

/**
 * Undo / restore: a new version whose content is `fromVersion`'s (server-side object copy, so the
 * history stays immutable and the two versions never share an object). A deleted doc is revived.
 */
export async function restoreMemory(
  tx: KobeTx,
  blobs: BlobStore,
  teamId: string,
  docId: string,
  fromVersion: number,
  actor: MemoryActor,
): Promise<RestoreResult> {
  const doc = await findDoc(tx, teamId, docId, true);
  const from = doc ? await versionRow(tx, teamId, docId, fromVersion) : undefined;
  if (!doc || !from) return { ok: false, code: "not_found" };
  const version = doc.currentVersion + 1;
  const blobRef = memoryBlobKey(blobs.prefix, teamId, docId, version);
  try {
    await blobs.objects.copy(from.blobRef, blobRef);
  } catch (err) {
    throw new MemoryStorageError("memory content could not be copied", { cause: err });
  }
  await tx.insert(memoryDocVersions).values({
    teamId,
    docId,
    version,
    blobRef,
    sizeBytes: from.sizeBytes,
    sha256: from.sha256,
    actorKind: actor.kind,
    actorUserId: actor.userId,
    runId: actor.runId ?? null,
    toolCallId: `${RESTORE_MARK}${fromVersion}`,
  });
  await tx
    .update(memoryDocs)
    .set({ currentVersion: version, deletedAt: null, updatedAt: new Date() })
    .where(and(eq(memoryDocs.teamId, teamId), eq(memoryDocs.id, docId)));
  return { ok: true, version, fromVersion, revived: doc.deletedAt !== null };
}

/** `tool_call_id` of a version made by restore (no column for the source; KOBE-154 has no migration slot). */
export const RESTORE_MARK = "restore:";

/** Soft delete: the history stays and Undo (restore) can bring the file back. */
export async function deleteMemory(
  tx: KobeTx,
  teamId: string,
  docId: string,
): Promise<{ readonly version: number } | null> {
  const doc = await findDoc(tx, teamId, docId, true);
  if (!doc || doc.deletedAt !== null) return null;
  await tx
    .update(memoryDocs)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(memoryDocs.teamId, teamId), eq(memoryDocs.id, docId)));
  return { version: doc.currentVersion };
}

export interface ListedDoc extends DocRow {
  readonly sizeBytes: number;
  readonly updatedBy: string | null;
}

/** Live docs of one scope owner, newest first; `MEMORY.md` is just another path. */
export async function listMemory(
  tx: KobeTx,
  teamId: string,
  target: MemoryTarget,
): Promise<ListedDoc[]> {
  const owner =
    target.scope === "user"
      ? and(eq(memoryDocs.scope, "user"), eq(memoryDocs.ownerUserId, target.ownerUserId))
      : and(eq(memoryDocs.scope, "project"), eq(memoryDocs.projectId, target.projectId));
  const rows = await tx
    .select({
      ...DOC_COLUMNS,
      sizeBytes: memoryDocVersions.sizeBytes,
      updatedBy: memoryDocVersions.actorUserId,
    })
    .from(memoryDocs)
    .innerJoin(
      memoryDocVersions,
      and(
        eq(memoryDocVersions.teamId, memoryDocs.teamId),
        eq(memoryDocVersions.docId, memoryDocs.id),
        eq(memoryDocVersions.version, memoryDocs.currentVersion),
      ),
    )
    .where(and(eq(memoryDocs.teamId, teamId), owner, isNull(memoryDocs.deletedAt)))
    .orderBy(desc(memoryDocs.updatedAt), asc(memoryDocs.path));
  return rows as ListedDoc[];
}

export interface DocVersion {
  readonly version: number;
  readonly sizeBytes: number;
  readonly createdAt: Date;
  readonly actorKind: "user" | "agent";
  readonly toolCallId: string | null;
  readonly actorUserId: string | null;
}

export async function listVersions(
  tx: KobeTx,
  teamId: string,
  docId: string,
): Promise<DocVersion[]> {
  const rows = await tx
    .select({
      version: memoryDocVersions.version,
      sizeBytes: memoryDocVersions.sizeBytes,
      createdAt: memoryDocVersions.createdAt,
      actorKind: memoryDocVersions.actorKind,
      toolCallId: memoryDocVersions.toolCallId,
      actorUserId: memoryDocVersions.actorUserId,
    })
    .from(memoryDocVersions)
    .where(and(eq(memoryDocVersions.teamId, teamId), eq(memoryDocVersions.docId, docId)))
    .orderBy(asc(memoryDocVersions.version));
  return rows as DocVersion[];
}

/** Current content of a doc, or null when the object is missing. */
export async function readCurrent(
  tx: KobeTx,
  blobs: BlobStore,
  teamId: string,
  doc: DocRow,
): Promise<string | null> {
  const v = await versionRow(tx, teamId, doc.id, doc.currentVersion);
  return v ? readVersionContent(blobs, v.blobRef) : null;
}
