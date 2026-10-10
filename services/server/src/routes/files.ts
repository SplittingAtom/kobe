import { Readable } from "node:stream";
import { Hono } from "hono";
import { files, and, eq, withTeam, type KobeTx } from "@kobe/db";
import { sharedFileSchema, type SharedFile } from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { threadKey } from "../retention/blobs.js";
import { invalidRequest } from "../teams/http.js";
import { findThread, type Viewer } from "../threads/repository.js";
import { viewerProjectIds } from "../threads/references.js";
import { uuidSchema } from "../threads/schemas.js";
import { attachmentDisposition } from "../workspace-files/paths.js";

const NOT_FOUND = { code: "file_not_found", message: "No file with that id." } as const;

/**
 * Files API for files the agent shared (`share_file`, KOBE-150): `GET /v1/files/:id` (metadata)
 * and `GET /v1/files/:id/content` (download, always an attachment with nosniff). A shared file is
 * readable exactly when its thread is (`findThread`: the owner, or members of a project the
 * thread is shared to); an unknown id, another team's file, another user's private thread, a
 * trashed or purged thread and a file the virus scan rejected are all the same 404. Uploads are
 * not served here: they are private to the uploader. Bytes come from the thread's own key tree.
 */
export function fileRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  const readable = (teamId: string, userId: string, id: string) =>
    withTeam(db, teamId, async (tx: KobeTx) => {
      const viewer: Viewer = {
        teamId,
        userId,
        projectIds: await viewerProjectIds(tx, teamId, userId),
      };
      const [row] = await tx
        .select()
        .from(files)
        .where(and(eq(files.teamId, teamId), eq(files.id, id), eq(files.kind, "shared")));
      if (!row || row.threadId === null || row.scanStatus === "rejected") return undefined;
      return (await findThread(tx, viewer, row.threadId)) ? row : undefined;
    });

  app.get("/:id", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const row = await readable(c.get("team").id, c.get("user").id, id.data);
    if (!row) return c.json(NOT_FOUND, 404);
    const body: SharedFile & { thread_id: string } = sharedFileSchema.parse({
      file_id: row.id,
      name: row.name,
      mime_type: row.mimeType,
      size_bytes: row.sizeBytes,
      scan: row.scanStatus === "clean" ? "clean" : "skipped",
      created_at: row.createdAt.toISOString(),
      sha256: row.sha256,
    }) as SharedFile & { thread_id: string };
    return c.json({ ...body, thread_id: row.threadId });
  });

  app.get("/:id/content", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const teamId = c.get("team").id;
    const row = await readable(teamId, c.get("user").id, id.data);
    if (!row || row.threadId === null) return c.json(NOT_FOUND, 404);
    const blobs = deps.blobs;
    const object =
      blobs && threadKey(blobs.prefix, teamId, row.threadId, row.blobRef)
        ? await blobs.objects.get(row.blobRef).catch((err: unknown) => {
            logger.error({ err, teamId }, "shared file unreadable");
            return null;
          })
        : null;
    if (!object) {
      return c.json(
        { code: "content_unavailable", message: "The file's content is unavailable." },
        503,
      );
    }
    return new Response(Readable.toWeb(object.body) as ReadableStream, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        "content-disposition": attachmentDisposition(row.name),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });

  return app;
}
