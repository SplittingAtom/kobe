import type { Context, Hono } from "hono";
import { z } from "zod";
import { withTeam } from "@kobe/db";
import { workspacePathSchema } from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { FRAME_HEADERS, isSameSiteFrameRequest, readCappedBody } from "../artifacts/serve.js";
import { logger } from "../logger.js";
import { uuidSchema } from "../threads/schemas.js";
import { isInternalPath } from "../workspace-files/paths.js";
import type { WorkspaceSync } from "../workspace-sync/service.js";
import { CONTENT_MISSING, reportMissingContent } from "../workspace-sync/lost.js";
import { currentEntry } from "../workspace-sync/store.js";

type Ctx = Context<{ Variables: TeamVariables }>;

/** The largest HTML file the frame serves; the viewer offers Download above it. */
export const WORKSPACE_FRAME_MAX_BYTES = 1024 * 1024;

/** Only these extensions are framed; every other file is refused before it is read. */
const HTML_FILE = /\.html?$/i;

/** Strict: unknown parameters are refused. The team is required (a frame can't send a header). */
const frameQuerySchema = z.strictObject({ path: workspacePathSchema, team: uuidSchema });

const notFound = (c: Ctx) => c.json({ code: "not_found", message: "No such file." }, 404);
const tooLarge = (c: Ctx) =>
  c.json({ code: "file_too_large", message: "This file is too large to show." }, 413);

/**
 * `GET /v1/workspace/frame?path=&team=` (KOBE-268): one of the caller's own synced HTML files as
 * the document of the file viewer's iframe, served exactly like an artifact frame (D-6/D25):
 * `FRAME_HEADERS` (CSP `sandbox` without `allow-same-origin`, so an opaque origin with no cookies
 * and no network), only for navigations from Kobe's own page, only for the active team the page
 * names, only `.html`/`.htm`, and at most {@link WORKSPACE_FRAME_MAX_BYTES}. The owner comes from
 * the session, never the request; reads are audited like downloads.
 */
export function registerWorkspaceFrame(
  app: Hono<{ Variables: TeamVariables }>,
  deps: ServerDeps,
  sync: WorkspaceSync,
): void {
  const db = deps.database.db;
  app.get("/frame", async (c) => {
    if (!isSameSiteFrameRequest(c.req.raw.headers, deps.publicUrl)) {
      return c.json({ code: "forbidden_origin", message: "Cross-origin request rejected." }, 403);
    }
    const query = frameQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!query.success) {
      return c.json({ code: "invalid_path", message: "That is not a valid frame request." }, 400);
    }
    const { path, team } = query.data;
    const owner = { teamId: c.get("team").id, userId: c.get("user").id };
    if (team !== owner.teamId) {
      return c.json(
        {
          code: "team_mismatch",
          message: "Your active team changed in another tab. Reload to continue.",
          activeTeamId: owner.teamId,
        },
        409,
      );
    }
    if (isInternalPath(path)) return notFound(c);
    if (!HTML_FILE.test(path)) {
      return c.json({ code: "not_frameable", message: "Only HTML files open in a frame." }, 400);
    }
    const found = await withTeam(db, owner.teamId, async (tx) => {
      const entry = await currentEntry(tx, owner, path);
      if (!entry || entry.deleted || entry.blobKey === null) return undefined;
      if (entry.size > WORKSPACE_FRAME_MAX_BYTES) return "too_large" as const;
      await recordAudit(tx, {
        action: "workspace.file_downloaded",
        teamId: owner.teamId,
        target: { userId: owner.userId, bytes: entry.size },
      });
      return entry;
    });
    if (found === undefined) return notFound(c);
    if (found === "too_large") return tooLarge(c);
    try {
      const object = await sync.objects.get(found.blobKey ?? "");
      if (!object) {
        // The file is there; its saved copy is not: the sandbox resends it (KOBE-475).
        await reportMissingContent(db, owner, found, sync.prefix, logger);
        return c.json({ code: "content_missing", message: CONTENT_MISSING }, 503);
      }
      if (object.size > WORKSPACE_FRAME_MAX_BYTES) {
        object.body.destroy();
        return tooLarge(c);
      }
      const bytes = await readCappedBody(object.body, WORKSPACE_FRAME_MAX_BYTES);
      if (bytes === "too_large") return tooLarge(c);
      return new Response(new Uint8Array(bytes), { headers: FRAME_HEADERS });
    } catch (err) {
      logger.error({ err, teamId: owner.teamId }, "workspace frame unreadable");
      return c.json(
        { code: "content_unavailable", message: "The file's content is unavailable." },
        503,
      );
    }
  });
}
