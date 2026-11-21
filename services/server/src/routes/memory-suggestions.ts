import { Hono, type Context } from "hono";
import { z } from "zod";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import type { NotesDeps } from "../memory/review/project-notes.js";
import { MemoryStorageError } from "../memory/store.js";
import {
  approvePreviewSchema,
  approveSchema,
  approveSuggestion,
  dismissSchema,
  dismissSuggestion,
  previewSuggestion,
} from "../memory/suggestions/decide.js";
import { listSuggestions } from "../memory/suggestions/list.js";
import { uuidSchema } from "../threads/schemas.js";
import { issueText, memoryRouteKit, refuseAgentWrites } from "./memory-items.js";
import { invalidRequest } from "../http/request.js";

const listQuery = z.object({ project_id: uuidSchema.optional() });

/**
 * Readers' suggestions to project Notes (`/v1/memory/suggestions`, KOBE-652). A reader makes one
 * from To review (`POST /v1/memory/review/candidates/:id/suggest`); here the project's editors,
 * owners and Team admins see and decide them. Everything is re-checked at each click
 * (memory/suggestions/decide.ts). Agents never decide.
 *
 * - `GET  /?project_id=` project Memory → Suggestions (with the caller's own); without: To review
 * - `POST /:id/preview` `{statement?}`: the exact Notes change, signed
 * - `POST /:id/approve` `{statement?, base_version, approval}`: appends under `## Learned`
 * - `POST /:id/dismiss` `{reason?}`
 */
export function memorySuggestionRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use("*", refuseAgentWrites);
  const { answer, readBody } = memoryRouteKit(deps);
  const suggestionId = (raw: string | undefined) => uuidSchema.safeParse(raw);
  // Read per request: building the app must not touch blobs or keys.
  const notes = (): NotesDeps => ({ db, blobs: deps.blobs, keys: deps.approvalKeys });
  const storage = async <T>(c: Context, fn: () => Promise<T>): Promise<T | Response> => {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof MemoryStorageError)) throw err;
      logger.error({ err }, "project notes storage failed");
      return c.json(
        { code: "storage_unavailable", message: "Memory storage is unavailable." },
        503,
      );
    }
  };

  app.get("/", async (c) => {
    const q = listQuery.safeParse(c.req.query());
    if (!q.success) return invalidRequest(c, "project_id must be a project id.");
    return answer(c, "user", (who) => listSuggestions(db, who, q.data.project_id));
  });

  app.post("/:id/preview", async (c) => {
    const id = suggestionId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a suggestion id.");
    const body = await readBody(c, approvePreviewSchema, true);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) =>
      storage(c, () => previewSuggestion(notes(), who, id.data, body.data)),
    );
  });

  app.post("/:id/approve", async (c) => {
    const id = suggestionId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a suggestion id.");
    const body = await readBody(c, approveSchema);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) =>
      storage(c, () => approveSuggestion(notes(), who, id.data, body.data)),
    );
  });

  app.post("/:id/dismiss", async (c) => {
    const id = suggestionId(c.req.param("id"));
    if (!id.success) return invalidRequest(c, "id must be a suggestion id.");
    const body = await readBody(c, dismissSchema, true);
    if (!body.success) return invalidRequest(c, issueText(body.error));
    return answer(c, "user", (who) => dismissSuggestion(notes(), who, id.data, body.data));
  });

  return app;
}
