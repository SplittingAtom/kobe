import { Hono } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  addBlocked,
  decodeBlockCursor,
  hashSchema,
  listBlocked,
  reasonSchema,
  removeBlocked,
} from "../skills/blocklist.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const addSchema = z.strictObject({ contentHash: hashSchema, reason: reasonSchema });
const limitSchema = z.coerce.number().int().min(1).max(200);

const entryJson = (e: { contentHash: string; reason: string; addedBy: string; addedAt: Date }) => ({
  contentHash: e.contentHash,
  reason: e.reason,
  addedBy: e.addedBy,
  addedAt: e.addedAt,
});

/**
 * The install skill blocklist (`/v1/install/skill-blocklist`, spec D22, KOBE-81): bundle hashes
 * that can't be uploaded, approved or run in any team. Install Owner/Admins only; every change is
 * audited (hash only, never bundle content).
 */
export function installSkillBlocklistRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.blocklist.manage"));

  app.get("/", async (c) => {
    const limit = limitSchema.safeParse(c.req.query("limit") ?? 50);
    const cursorText = c.req.query("cursor");
    const cursor = cursorText === undefined ? undefined : decodeBlockCursor(cursorText);
    if (!limit.success || (cursorText !== undefined && !cursor))
      return invalidRequest(c, "limit must be 1 to 200 and cursor one this API returned.");
    const page = await listBlocked(db, { limit: limit.data, ...(cursor ? { cursor } : {}) });
    return c.json({ entries: page.entries.map(entryJson), nextCursor: page.nextCursor });
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, addSchema);
    if (!body)
      return invalidRequest(
        c,
        "Send contentHash (64 hex characters) and a reason of up to 500 characters.",
      );
    const entry = await addBlocked(db, {
      hash: body.contentHash,
      reason: body.reason,
      userId: c.get("user").id,
    });
    if (!entry)
      return c.json({ code: "already_blocked", message: "That hash is already blocked." }, 409);
    return c.json({ entry: entryJson(entry) }, 201);
  });

  app.delete("/:hash", async (c) => {
    const hash = hashSchema.safeParse(c.req.param("hash"));
    if (!hash.success || !(await removeBlocked(db, hash.data)))
      return c.json({ code: "not_found", message: "That hash is not on the blocklist." }, 404);
    return c.body(null, 204);
  });

  return app;
}
