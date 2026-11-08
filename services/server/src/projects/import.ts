import { Readable } from "node:stream";
import { withTeam, type KobeDb, type TeamRole } from "@kobe/db";
import { toProtocolTeamRole } from "../authz/team-role.js";
import {
  artifactFileExtension,
  artifactFileStem,
  artifactMimeType,
  canAddToProject,
  projectFileNameSchema,
  type ImportProjectFileRequest,
  type ProjectFile,
} from "@kobe/protocol";
import { findVersionBlob } from "../artifacts/repository.js";
import { readArtifactVersion } from "../artifacts/serve.js";
import { logger } from "../logger.js";
import type { BlobStore } from "../retention/blobs.js";
import { viewerProjectIds } from "../threads/references.js";
import { baseName, isInternalPath } from "../workspace-files/paths.js";
import { reportMissingContent } from "../workspace-sync/lost.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import { currentEntry } from "../workspace-sync/store.js";
import { loadAccess } from "./access.js";
import {
  uploadProjectFile,
  type ImportedFrom,
  type ProjectFileDeps,
  type ProjectFileFailure,
} from "./files.js";

/**
 * Add to project (KOBE-585, workspaces lane WS-2): copies an artifact version or the caller's own
 * synced workspace file into a project as a read-only project file. The bytes are the ones the
 * server stored (the artifact version from the thread's object tree, as Edit as file reads it; the
 * workspace store's copy of the caller's file, never another member's and never the browser's)
 * and go through {@link uploadProjectFile}, so the size cap, the project's file count, the team
 * storage quota, the name rules and the `project.file_added` audit row (ids only, plus
 * `importedFrom`: the artifact id and version, or just the kind for a workspace file) are the
 * upload's. The file keeps `source: "upload"`: the `project_files_source` CHECK allows no other
 * value without a migration.
 *
 * Order of refusals: the project (404 when the caller can't view it, 409 when archived), the
 * source (404 when the caller can't read it), the right ({@link canAddToProject}, 403), the name,
 * then the copy itself. Nothing is read from storage before every check passed.
 */
export interface ImportDeps extends ProjectFileDeps {
  readonly db: KobeDb;
  readonly blobs: BlobStore | undefined;
  readonly sync: WorkspaceSync | undefined;
}

export interface Importer {
  readonly teamId: string;
  readonly userId: string;
  readonly teamRole: TeamRole;
}

export type ImportRefusal =
  | "project_not_found"
  | "source_not_found"
  | "forbidden"
  | "invalid_name"
  | "content_unavailable"
  | "content_missing";

export type ImportOutcome =
  | { readonly ok: true; readonly file: ProjectFile }
  | { readonly ok: false; readonly error: ImportRefusal | ProjectFileFailure };

type Opened = Readable | ImportRefusal | "file_too_large";

interface Source {
  readonly contentOwner: boolean;
  readonly defaultName: string;
  readonly declaredMime: string;
  readonly importedFrom: ImportedFrom;
  /** Opens the bytes once every check passed. */
  open(): Promise<Opened>;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  svg: "image/svg+xml",
  json: "application/json",
  mmd: "text/plain",
  py: "text/x-python",
  ts: "text/plain",
  js: "text/javascript",
  sql: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  ipynb: "application/json",
};

/** A workspace file's declared type from its name (the bytes' signature still wins, `resolveMime`). */
export function mimeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  // Unknown: let the signature decide (a declared text type would win over a zip's, e.g. docx).
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

async function artifactSource(
  deps: ImportDeps,
  who: Importer,
  artifactId: string,
  version: number,
): Promise<Source | undefined> {
  const found = await withTeam(deps.db, who.teamId, async (tx) =>
    findVersionBlob(
      tx,
      {
        teamId: who.teamId,
        userId: who.userId,
        projectIds: await viewerProjectIds(tx, who.teamId, who.userId),
      },
      artifactId,
      version,
    ),
  );
  if (!found) return undefined;
  const { artifact } = found;
  const ext = artifactFileExtension(artifact.kind, artifact.language);
  return {
    contentOwner: found.access === "owner",
    defaultName: `${artifactFileStem(artifact.title)}.${ext}`,
    declaredMime: artifactMimeType(artifact.kind, artifact.language),
    importedFrom: { kind: "artifact", artifactId, version },
    open: async () => {
      const blobs = deps.blobs;
      if (!blobs) return "content_unavailable";
      let read: Awaited<ReturnType<typeof readArtifactVersion>>;
      try {
        read = await readArtifactVersion(blobs, who.teamId, artifact.thread_id, found.blobRef);
      } catch (err) {
        logger.error({ err, teamId: who.teamId }, "add to project: artifact unreadable");
        return "content_unavailable";
      }
      if (read === "missing") return "source_not_found"; // purged, or outside the thread's tree
      if (read === "too_large") return "file_too_large";
      return Readable.from([read]);
    },
  };
}

async function workspaceSource(
  deps: ImportDeps,
  who: Importer,
  path: string,
): Promise<Source | undefined> {
  const sync = deps.sync;
  if (!sync || isInternalPath(path)) return undefined;
  const owner = { teamId: who.teamId, userId: who.userId };
  const entry = await withTeam(deps.db, who.teamId, (tx) => currentEntry(tx, owner, path));
  if (!entry || entry.deleted || entry.blobKey === null) return undefined;
  const blobKey = entry.blobKey;
  const name = baseName(path);
  return {
    // `/v1/workspace` is the caller's own workspace only: the caller owns the file.
    contentOwner: true,
    defaultName: name,
    declaredMime: mimeForName(name),
    importedFrom: { kind: "workspace_file" },
    open: async () => {
      const object = await sync.objects.get(blobKey).catch((err: unknown) => {
        logger.error({ err, teamId: who.teamId }, "add to project: workspace file unreadable");
        return "unavailable" as const;
      });
      if (object === "unavailable") return "content_unavailable";
      if (!object) {
        await reportMissingContent(deps.db, owner, entry, sync.prefix, logger);
        return "content_missing";
      }
      return object.body;
    },
  };
}

export async function importProjectFile(
  deps: ImportDeps,
  who: Importer,
  projectId: string,
  request: ImportProjectFileRequest,
): Promise<ImportOutcome> {
  const viewer = { teamId: who.teamId, userId: who.userId };
  const access = await withTeam(deps.db, who.teamId, (tx) => loadAccess(tx, viewer, projectId));
  if (!access) return { ok: false, error: "project_not_found" };
  // Checked again under the project lock when the row is inserted.
  if (access.project.archivedAt !== null) return { ok: false, error: "archived" };
  const { source: wanted } = request;
  const source =
    wanted.kind === "artifact"
      ? await artifactSource(deps, who, wanted.artifact_id, wanted.version)
      : await workspaceSource(deps, who, wanted.path);
  if (!source) return { ok: false, error: "source_not_found" };
  if (!canAddToProject(toProtocolTeamRole(who.teamRole), access.role, "restricted")) {
    return { ok: false, error: "forbidden" };
  }
  const name = request.name ?? source.defaultName;
  if (!projectFileNameSchema.safeParse(name).success) return { ok: false, error: "invalid_name" };
  const body = await source.open();
  if (typeof body === "string") return { ok: false, error: body };
  return uploadProjectFile(
    deps,
    { teamId: who.teamId, projectId: access.project.id, userId: who.userId },
    {
      folder: request.folder,
      name,
      declaredMime: source.declaredMime,
      body,
      importedFrom: source.importedFrom,
    },
  );
}
