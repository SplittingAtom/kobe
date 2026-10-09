import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Hono } from "hono";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest } from "../teams/http.js";
import { openUpload } from "../uploads/parse.js";
import { createClamdScanner } from "../uploads/clamd.js";
import { DEFAULT_UPLOAD_SETTINGS } from "../uploads/settings.js";
import { storeUpload } from "../uploads/store.js";

/**
 * `POST /v1/uploads` (KOBE-143; contract in packages/protocol `uploads.ts`): multipart/form-data
 * with an optional `thread_id` text field and one file part, streamed to object storage. 201
 * `uploadResponseSchema`; refusals use `uploadErrorSchema` (413 / 403 / 422 / 503). Further file
 * parts after the first are ignored. Uploads are private to the uploading user.
 */
export function uploadRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.post("/", async (c) => {
    const blobs = deps.blobs;
    if (!blobs) {
      return c.json(
        { code: "storage_unavailable", message: "File storage is not configured." },
        503,
      );
    }
    const body = c.req.raw.body;
    if (!body) return invalidRequest(c, "No file was sent.");
    const opened = await openUpload(
      c.req.header("content-type"),
      // The web stream of the request is bridged to Node so the parser can pull from it.
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
    );
    if (!opened.ok) return invalidRequest(c, opened.reason);
    const length = Number(c.req.header("content-length"));
    const { upload } = opened;
    const settings = deps.uploads ?? DEFAULT_UPLOAD_SETTINGS;
    const result = await storeUpload(
      {
        db: deps.database.db,
        blobs,
        settings,
        ...(settings.clamav ? { scan: createClamdScanner(settings.clamav, blobs.objects) } : {}),
      },
      { teamId: c.get("team").id, userId: c.get("user").id },
      {
        threadId: upload.threadId,
        name: upload.name,
        declaredMime: upload.declaredMime,
        file: upload.file,
        contentLength: Number.isSafeInteger(length) && length >= 0 ? length : undefined,
      },
    );
    return result.ok ? c.json(result.file, 201) : c.json(result.body, result.status);
  });

  return app;
}
