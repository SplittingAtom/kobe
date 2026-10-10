import { Hono } from "hono";
import type { Context } from "hono";
import { withTeam, type KobeTx } from "@kobe/db";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { artifactDetail, findVersionBlob, listArtifacts } from "../artifacts/repository.js";
import {
  FRAME_HEADERS,
  artifactExtension,
  fileStem,
  readArtifactBytes,
  svgDocument,
} from "../artifacts/serve.js";
import { invalidRequest } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";
import { viewerProjectIds } from "../threads/references.js";
import type { Viewer } from "../threads/repository.js";

type ArtifactContext = Context<{ Variables: TeamVariables }>;

/** Browsers mark a navigation another site started; a frame must come from Kobe's own page. */
const SAME_SITE_FETCH = new Set(["same-origin", "none"]);
const NOT_FOUND = { code: "artifact_not_found", message: "No artifact with that id." } as const;

const versionParam = (raw: string): number | undefined => {
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) return undefined;
  return Number(raw);
};

/**
 * Artifact API (D-6 of KOBE-55; spec D25): list a thread's artifacts, read one with its versions,
 * and serve a version's content (download and renderers) or its iframe document (`/frame`, html and
 * svg only). Same auth, team and thread visibility as reading the thread: an artifact is readable
 * exactly when its thread is, and anything else is a 404. Content comes from S3 under the
 * thread's own key tree; the database holds only references.
 */
export function artifactRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  const asViewer = <T>(c: ArtifactContext, fn: (tx: KobeTx, viewer: Viewer) => Promise<T>) => {
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    return withTeam(db, teamId, async (tx) =>
      fn(tx, { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) }),
    );
  };

  /** The version's bytes and metadata, or the error response. */
  const loadVersion = async (c: ArtifactContext) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    const n = versionParam(c.req.param("n") ?? "");
    if (!id.success || n === undefined) return { response: invalidRequest(c) };
    const found = await asViewer(c, (tx, viewer) => findVersionBlob(tx, viewer, id.data, n));
    if (!found) {
      return {
        response: c.json({ code: "version_not_found", message: "No such artifact version." }, 404),
      };
    }
    const blobs = deps.blobs;
    const bytes = blobs
      ? await readArtifactBytes(
          blobs,
          c.get("team").id,
          found.artifact.thread_id,
          found.blobRef,
        ).catch((err: unknown) => {
          logger.error({ err, teamId: c.get("team").id }, "artifact content unreadable");
          return undefined;
        })
      : undefined;
    if (!bytes) {
      return {
        response: c.json(
          { code: "content_unavailable", message: "The artifact's content is unavailable." },
          503,
        ),
      };
    }
    return { found, bytes, n };
  };

  app.get("/", async (c) => {
    const threadId = uuidSchema.safeParse(c.req.query("thread_id"));
    if (!threadId.success) return invalidRequest(c);
    const list = await asViewer(c, (tx, viewer) => listArtifacts(tx, viewer, threadId.data));
    if (!list) {
      return c.json({ code: "thread_not_found", message: "No thread with that id." }, 404);
    }
    return c.json({ artifacts: list });
  });

  app.get("/:id", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return invalidRequest(c);
    const detail = await asViewer(c, (tx, viewer) => artifactDetail(tx, viewer, id.data));
    return detail ? c.json(detail) : c.json(NOT_FOUND, 404);
  });

  app.get("/:id/versions/:n/content", async (c) => {
    const loaded = await loadVersion(c);
    if ("response" in loaded) return loaded.response;
    const { found, bytes, n } = loaded;
    const { kind, language, title } = found.artifact;
    const name = `${fileStem(title)}-v${n}.${artifactExtension(kind, language)}`;
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "private, no-store",
      },
    });
  });

  /**
   * The document for the panel's iframe. A frame can't send `X-Kobe-Team`, so the team the page
   * believes is active comes as `?team=` and must match the session's (as the thread export).
   */
  app.get("/:id/versions/:n/frame", async (c) => {
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    if (
      (site !== undefined && !SAME_SITE_FETCH.has(site)) ||
      (origin !== undefined && origin !== deps.publicUrl)
    ) {
      return c.json({ code: "forbidden_origin", message: "Cross-origin request rejected." }, 403);
    }
    const team = c.get("team");
    const claimed = c.req.query("team");
    if (claimed !== undefined && claimed !== team.id) {
      return c.json(
        {
          code: "team_mismatch",
          message: "Your active team changed in another tab. Reload to continue.",
          activeTeamId: team.id,
        },
        409,
      );
    }
    const loaded = await loadVersion(c);
    if ("response" in loaded) return loaded.response;
    const { found, bytes } = loaded;
    const { kind } = found.artifact;
    if (kind !== "html" && kind !== "svg") {
      return c.json(
        { code: "not_frameable", message: "Only html and svg artifacts open in a frame." },
        400,
      );
    }
    const text = bytes.toString("utf8");
    return new Response(kind === "svg" ? svgDocument(text) : text, { headers: FRAME_HEADERS });
  });

  return app;
}
