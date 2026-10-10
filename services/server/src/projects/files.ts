import { randomUUID } from "node:crypto";
import { pipeline, type Readable } from "node:stream";
import {
  and,
  asc,
  count,
  eq,
  projectFiles,
  projects,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import {
  PROJECT_FILES_MAX,
  PROJECT_FILE_MAX_BYTES,
  workspacePathSchema,
  type ProjectFile,
} from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";
import type { BlobStore } from "../retention/blobs.js";
import { resolveMime, SNIFF_BYTES } from "../uploads/mime.js";
import { UploadMeter, UploadTooLargeError } from "../uploads/meter.js";
import { lockTeamStorage, storageLimit, storageUsed } from "../uploads/quota.js";

/**
 * Project files (KOBE-162, D23): the project's own copy of each file lives in object storage at
 * `<prefix>teams/<team>/projects/<project>/files/<file id>` (not a thread tree: no thread purge
 * touches it) and is described by one `project_files` row. {@link ProjectMounts} makes the rows
 * visible read-only in members' workspaces. Upload bytes stream through a staging object (bounded
 * memory, hash and size known at the end), are copied to their key, and the row, the team storage
 * quota check and the audit event commit together. Names and paths never reach the audit log.
 */
export type ProjectFileFailure =
  | "invalid_path"
  | "already_exists"
  | "file_too_large"
  | "quota_exceeded"
  | "project_full"
  | "archived"
  | "storage_failed";

export type FileOutcome =
  | { readonly ok: true; readonly file: ProjectFile }
  | { readonly ok: false; readonly error: ProjectFileFailure };

export interface ProjectFileDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore | undefined;
  /** Install defaults: largest single file and the team storage quota default. */
  readonly maxFileBytes: number;
  readonly teamQuotaDefaultBytes: number;
}

export interface FileTarget {
  readonly teamId: string;
  readonly projectId: string;
  /** Who adds it (the uploader, or the user whose run proposed it). */
  readonly userId: string;
}

type Row = typeof projectFiles.$inferSelect;

export const toProjectFile = (row: Row): ProjectFile => ({
  id: row.id,
  project_id: row.projectId,
  path: row.path,
  size_bytes: row.sizeBytes,
  sha256: row.sha256,
  mime_type: row.mimeType,
  source: row.source,
  added_by: row.addedBy,
  added_at: row.addedAt.toISOString(),
});

export async function listProjectFiles(
  tx: KobeTx,
  teamId: string,
  projectId: string,
): Promise<ProjectFile[]> {
  const rows = await tx
    .select()
    .from(projectFiles)
    .where(and(eq(projectFiles.teamId, teamId), eq(projectFiles.projectId, projectId)))
    .orderBy(asc(projectFiles.path));
  return rows.map(toProjectFile);
}

/** `folder/name` inside the project, or undefined when it is not a valid workspace path. */
export function projectFilePath(folder: string | undefined, name: string): string | undefined {
  const joined = folder === undefined || folder === "" ? name : `${folder}/${name}`;
  const parsed = workspacePathSchema.safeParse(joined);
  return parsed.success ? parsed.data : undefined;
}

export const projectFileKey = (
  blobs: BlobStore,
  teamId: string,
  projectId: string,
  fileId: string,
): string => `${blobs.prefix}teams/${teamId}/projects/${projectId}/files/${fileId}`;

const stagingKey = (blobs: BlobStore, teamId: string, projectId: string): string =>
  `${blobs.prefix}teams/${teamId}/projects/${projectId}/staging/${randomUUID()}`;

async function discard(blobs: BlobStore, key: string): Promise<void> {
  try {
    await blobs.objects.delete([key]);
  } catch (err) {
    logger.warn({ err }, "project file: could not delete an object");
  }
}

class Refused extends Error {
  constructor(readonly failure: ProjectFileFailure) {
    super(failure);
  }
}

/**
 * Checks and inserts the row in `tx` (the caller's transaction, project row already locked):
 * archived, file count, name taken, team storage quota. Throws {@link Refused}.
 */
export async function insertProjectFile(
  tx: KobeTx,
  deps: Pick<ProjectFileDeps, "teamQuotaDefaultBytes">,
  target: FileTarget,
  file: {
    readonly id: string;
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly mime: string;
    readonly blobRef: string;
    readonly source: "upload" | "proposal";
  },
): Promise<ProjectFile> {
  const { teamId, projectId, userId } = target;
  const [project] = await tx
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(and(eq(projects.teamId, teamId), eq(projects.id, projectId)))
    .for("update");
  if (!project) throw new Refused("storage_failed");
  if (project.archivedAt !== null) throw new Refused("archived");
  const [held] = await tx
    .select({ n: count() })
    .from(projectFiles)
    .where(and(eq(projectFiles.teamId, teamId), eq(projectFiles.projectId, projectId)));
  if ((held?.n ?? 0) >= PROJECT_FILES_MAX) throw new Refused("project_full");
  const [taken] = await tx
    .select({ id: projectFiles.id })
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.teamId, teamId),
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.path, file.path),
      ),
    );
  if (taken) throw new Refused("already_exists");
  await lockTeamStorage(tx, teamId);
  const limit = await storageLimit(tx, teamId, deps.teamQuotaDefaultBytes);
  if ((await storageUsed(tx, teamId)) + file.size > limit) throw new Refused("quota_exceeded");
  const [row] = await tx
    .insert(projectFiles)
    .values({
      teamId,
      id: file.id,
      projectId,
      path: file.path,
      sizeBytes: file.size,
      sha256: file.sha256,
      mimeType: file.mime,
      blobRef: file.blobRef,
      source: file.source,
      addedBy: userId,
    })
    .returning();
  if (!row) throw new Error("project_files insert returned no row");
  await recordAudit(tx, {
    action: "project.file_added",
    actor: { kind: "user", id: userId },
    teamId,
    target: { projectId, fileId: file.id, source: file.source, sizeBytes: file.size },
  });
  return toProjectFile(row);
}

/** Commits a stored object as a project file; discards the object when the commit is refused. */
export async function commitProjectFile(
  deps: ProjectFileDeps,
  blobs: BlobStore,
  target: FileTarget,
  file: Parameters<typeof insertProjectFile>[3],
): Promise<FileOutcome> {
  try {
    const stored = await withTeam(deps.db, target.teamId, (tx) =>
      insertProjectFile(tx, deps, target, file),
    );
    return { ok: true, file: stored };
  } catch (err) {
    if (err instanceof Refused) {
      await discard(blobs, file.blobRef);
      return { ok: false, error: err.failure };
    }
    // Ambiguous failures keep the object (a committed row may reference it).
    logger.error({ err, teamId: target.teamId }, "project file commit failed");
    return { ok: false, error: "storage_failed" };
  }
}

async function headOf(blobs: BlobStore, key: string): Promise<Uint8Array> {
  const object = await blobs.objects.get(key);
  if (!object) throw new Error("project file copy is missing");
  const chunks: Buffer[] = [];
  let have = 0;
  try {
    for await (const chunk of object.body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      have += chunk.length;
      if (have >= SNIFF_BYTES) break;
    }
  } finally {
    object.body.destroy();
  }
  return Buffer.concat(chunks).subarray(0, SNIFF_BYTES);
}

export interface IncomingProjectFile {
  readonly folder: string | undefined;
  readonly name: string;
  readonly declaredMime: string;
  readonly body: Readable;
}

/** A person's upload: stream, hash, copy to the file's key, then the row (see module header). */
export async function uploadProjectFile(
  deps: ProjectFileDeps,
  target: FileTarget,
  incoming: IncomingProjectFile,
): Promise<FileOutcome> {
  const blobs = deps.blobs;
  if (!blobs) return { ok: false, error: "storage_failed" };
  const path = projectFilePath(incoming.folder, incoming.name);
  if (path === undefined) return { ok: false, error: "invalid_path" };
  const limit = Math.min(PROJECT_FILE_MAX_BYTES, deps.maxFileBytes);
  const staging = stagingKey(blobs, target.teamId, target.projectId);
  const meter = new UploadMeter(limit);
  try {
    pipeline(incoming.body, meter, () => undefined);
    await blobs.objects.putStream(staging, meter);
  } catch (err) {
    meter.destroy();
    incoming.body.destroy();
    await discard(blobs, staging);
    if (err instanceof UploadTooLargeError || meter.bytes > limit) {
      return { ok: false, error: "file_too_large" };
    }
    logger.error({ err, teamId: target.teamId }, "project file upload failed");
    return { ok: false, error: "storage_failed" };
  }
  const id = randomUUID();
  const key = projectFileKey(blobs, target.teamId, target.projectId, id);
  try {
    await blobs.objects.copy(staging, key);
  } catch (err) {
    logger.error({ err, teamId: target.teamId }, "project file copy failed");
    await discard(blobs, staging);
    return { ok: false, error: "storage_failed" };
  }
  await discard(blobs, staging);
  let mime: string;
  try {
    mime = resolveMime(await headOf(blobs, key), incoming.declaredMime);
  } catch {
    await discard(blobs, key);
    return { ok: false, error: "storage_failed" };
  }
  return commitProjectFile(deps, blobs, target, {
    id,
    path,
    size: meter.bytes,
    sha256: meter.digest(),
    mime,
    blobRef: key,
    source: "upload",
  });
}

/**
 * Removes a file's row (audited, in the caller's transaction) and returns its object key, or
 * undefined when there is no such file. The caller deletes the object once the mounts no longer
 * name it (`ProjectMounts.reconcileProject`); a crash in between leaves an unreferenced object,
 * never a dangling row.
 */
export async function removeProjectFile(
  tx: KobeTx,
  actorId: string,
  teamId: string,
  projectId: string,
  fileId: string,
): Promise<string | undefined> {
  const [row] = await tx
    .delete(projectFiles)
    .where(
      and(
        eq(projectFiles.teamId, teamId),
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.id, fileId),
      ),
    )
    .returning({ blobRef: projectFiles.blobRef });
  if (!row) return undefined;
  await recordAudit(tx, {
    action: "project.file_removed",
    actor: { kind: "user", id: actorId },
    teamId,
    target: { projectId, fileId },
  });
  return row.blobRef;
}

/** Deletes a project file's object; failures are logged (an orphan object, never a leak of access). */
export async function deleteProjectObject(
  blobs: BlobStore | undefined,
  key: string,
): Promise<void> {
  if (blobs) await discard(blobs, key);
}
