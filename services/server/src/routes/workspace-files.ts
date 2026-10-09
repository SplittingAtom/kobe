import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Hono, type Context } from "hono";
import { isUnderLegalHold, lockLegalHolds, withTeam } from "@kobe/db";
import {
  UPLOAD_DEFAULT_MAX_FILE_BYTES,
  workspaceDeleteQuerySchema,
  workspaceDownloadQuerySchema,
  workspaceListQuerySchema,
  workspacePathSchema,
  workspaceUploadFieldsSchema,
  type WorkspaceFileError,
} from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { openUpload } from "../uploads/parse.js";
import { DEFAULT_UPLOAD_SETTINGS } from "../uploads/settings.js";
import type { SandboxWaker } from "../sandbox-wire/types.js";
import {
  decodeCursor,
  fileEntry,
  LIST_MAX_ENTRIES,
  listFolder,
  liveFilesUnder,
} from "../workspace-files/browse.js";
import {
  attachmentDisposition,
  isInternalPath,
  isReadOnlyPath,
  joinPath,
} from "../workspace-files/paths.js";
import { uploadToWorkspace } from "../workspace-files/upload.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import { currentEntry } from "../workspace-sync/store.js";

type Ctx = Context<{ Variables: TeamVariables }>;
type ErrStatus = 400 | 403 | 404 | 409 | 411 | 413 | 415 | 422 | 502 | 503 | 507;

/** Largest folder delete in one request (all-or-nothing, one transaction). */
const DELETE_MAX_FILES = 10_000;
/** Multipart framing allowed on top of the file itself. */
const MULTIPART_OVERHEAD = 64 * 1024;

export interface WorkspaceFilesOptions {
  readonly sync: WorkspaceSync;
  /** Wakes the caller's sandbox when the panel opens (sandbox-lifecycle's waker). */
  readonly waker: SandboxWaker;
  /** Entries per listing page (default {@link LIST_MAX_ENTRIES}; tests use small pages). */
  readonly listPageSize?: number;
}

const fail = (c: Ctx, status: ErrStatus, code: WorkspaceFileError["code"], message: string) =>
  c.json({ code, message }, status);
const badPath = (c: Ctx) => fail(c, 400, "invalid_path", "That is not a valid workspace path.");
const notFound = (c: Ctx) => fail(c, 404, "not_found", "No such file or folder.");
const readOnly = (c: Ctx) =>
  fail(c, 403, "read_only", "Project files and thread uploads are read-only here.");

/** All query parameters, so the strict contract schemas reject unknown ones. */
const queryOf = (c: Ctx) => Object.fromEntries(new URL(c.req.url).searchParams);

/**
 * Workspace file browser API (KOBE-148, contract packages/protocol/src/files.ts; notes in
 * docs/ledger/KOBE-148.md). Every route works on the caller's own (team, user) workspace: the owner
 * is read from the session, never from the request, so no path or parameter can name another
 * member's files. Paths are matched against the synced manifest only. Without object storage
 * (`options` undefined) every route answers 503.
 */
export function workspaceFileRoutes(
  deps: ServerDeps,
  options: WorkspaceFilesOptions | undefined,
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  if (!options) {
    app.all("*", (c) =>
      fail(c, 503, "sandbox_unavailable", "Workspace storage is not configured."),
    );
    return app;
  }
  const { sync, waker } = options;
  const pageSize = options.listPageSize ?? LIST_MAX_ENTRIES;
  const ownerOf = (c: Ctx) => ({ teamId: c.get("team").id, userId: c.get("user").id });

  app.get("/files", async (c) => {
    const query = workspaceListQuerySchema.safeParse(queryOf(c));
    if (!query.success) return badPath(c);
    const folder = query.data.path ?? "";
    if (folder !== "" && isInternalPath(folder)) return notFound(c);
    const after = query.data.cursor === undefined ? undefined : decodeCursor(query.data.cursor);
    if (query.data.cursor !== undefined && !after) {
      return c.json({ code: "invalid_request", message: "That cursor is not valid." }, 400);
    }
    const owner = ownerOf(c);
    const listing = await withTeam(db, owner.teamId, (tx) =>
      listFolder(tx, owner, folder, { limit: pageSize, ...(after ? { after } : {}) }),
    );
    // Folders exist only through their files: an unknown or emptied one is not found (on the
    // first page; a later page may legitimately be empty if files went away meanwhile).
    if (folder !== "" && listing.entries.length === 0 && !after) return notFound(c);
    return c.json({
      path: folder,
      entries: listing.entries,
      ...(listing.nextCursor === undefined ? {} : { next_cursor: listing.nextCursor }),
    });
  });

  app.get("/file", async (c) => {
    const query = workspaceDownloadQuerySchema.safeParse(queryOf(c));
    if (!query.success) return badPath(c);
    const owner = ownerOf(c);
    const entry = await withTeam(db, owner.teamId, async (tx) => {
      const found = await currentEntry(tx, owner, query.data.path);
      if (!found || found.deleted || found.blobKey === null) return undefined;
      await recordAudit(tx, {
        action: "workspace.file_downloaded",
        teamId: owner.teamId,
        target: { userId: owner.userId, bytes: found.size },
      });
      return found;
    });
    if (!entry?.blobKey) return notFound(c);
    const object = await sync.objects.get(entry.blobKey).catch((err: unknown) => {
      logger.error({ err, teamId: owner.teamId }, "workspace file unreadable");
      return null;
    });
    if (!object) return fail(c, 404, "not_found", "The file's content is no longer available.");
    return new Response(Readable.toWeb(object.body) as ReadableStream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        "content-disposition": attachmentDisposition(query.data.path),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });

  app.post("/files", async (c) => {
    if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
      return c.json({ code: "invalid_request", message: "Send multipart/form-data." }, 415);
    }
    const maxBytes = Math.min(sync.limits.maxFileBytes, UPLOAD_DEFAULT_MAX_FILE_BYTES);
    const length = Number(c.req.header("content-length") ?? "NaN");
    if (!Number.isSafeInteger(length) || length < 0) {
      return c.json({ code: "invalid_request", message: "Content-Length is required." }, 411);
    }
    if (length > maxBytes + MULTIPART_OVERHEAD) {
      return fail(c, 413, "file_too_large", `Files over ${maxBytes} bytes are not accepted.`);
    }
    const body = c.req.raw.body;
    if (!body) return c.json({ code: "invalid_request", message: "Malformed upload." }, 400);
    // Streamed: the file reaches object storage without ever being held (KOBE-184).
    const opened = await openUpload(
      c.req.header("content-type"),
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      workspaceUploadFieldsSchema,
    );
    if (!opened.ok) return c.json({ code: "invalid_request", message: opened.reason }, 400);
    const { upload } = opened;
    const refuse = (res: Response): Response => {
      upload.file.destroy();
      return res;
    };
    const folder = upload.fields.path ?? "";
    const target = joinPath(folder, upload.name);
    if (!workspacePathSchema.safeParse(target).success || isInternalPath(target)) {
      return refuse(badPath(c));
    }
    if (isReadOnlyPath(target)) return refuse(readOnly(c));
    const result = await uploadToWorkspace(db, sync, ownerOf(c), target, {
      body: upload.file,
      limitBytes: maxBytes,
      teamQuotaDefaultBytes: (deps.uploads ?? DEFAULT_UPLOAD_SETTINGS).defaultQuotaBytes,
    });
    if (!result.ok) return fail(c, result.status, result.code, result.message);
    return c.json(fileEntry(result.entry), 201);
  });

  app.delete("/files", async (c) => {
    const query = workspaceDeleteQuerySchema.safeParse(queryOf(c));
    if (!query.success) return badPath(c);
    const { path } = query.data;
    if (isInternalPath(path)) return badPath(c);
    if (isReadOnlyPath(path)) return readOnly(c);
    const owner = ownerOf(c);
    const outcome = await withTeam(db, owner.teamId, async (tx) => {
      // Deleting lets the workspace collector free content later: never past a legal hold.
      await lockLegalHolds(tx);
      if (await isUnderLegalHold(tx, owner.teamId, owner.userId)) return "held" as const;
      const files = await liveFilesUnder(tx, owner, path, DELETE_MAX_FILES + 1);
      if (files.length === 0) return "missing" as const;
      if (files.length > DELETE_MAX_FILES) return "too_many" as const;
      for (const file of files) await sync.deleteServerFile(tx, owner, file.path);
      await recordAudit(tx, {
        action: "workspace.file_deleted",
        teamId: owner.teamId,
        target: {
          userId: owner.userId,
          files: files.length,
          bytes: files.reduce((sum, f) => sum + f.size, 0),
        },
      });
      return "deleted" as const;
    });
    switch (outcome) {
      case "held":
        return fail(
          c,
          409,
          "legal_hold",
          "This workspace is under a legal hold; nothing can be deleted.",
        );
      case "missing":
        return notFound(c);
      case "too_many":
        return fail(
          c,
          422,
          "invalid_path",
          "That folder holds too many files; delete subfolders first.",
        );
      case "deleted":
        return c.body(null, 204);
    }
  });

  /** The panel opened: start the caller's sandbox so live files and the next sync are ready. */
  app.post("/wake", (c) => {
    const owner = ownerOf(c);
    void waker.wake(owner).catch((err: unknown) => {
      logger.warn({ err, teamId: owner.teamId }, "workspace panel wake failed");
    });
    return c.json({ status: "waking" }, 202);
  });

  return app;
}
