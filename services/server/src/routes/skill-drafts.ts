import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireTeam, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { hitRateLimit } from "../rate-limit.js";
import { SKILL_UPLOAD_RATE } from "../skills/limits.js";
import { PostgresSkillStore, type SkillStore } from "../skills/skill-store.js";
import { changelogSchema, semverSchema } from "../skills/semver.js";
import { DRAFT_LIMITS, DRAFT_WRITE_RATE, pathFromUrl } from "../skills/drafts/files.js";
import type { DraftFileInfo, DraftRecord } from "../skills/drafts/records.js";
import { saveDraftVersion } from "../skills/drafts/save.js";
import {
  createBlankDraft,
  deleteDraftFile,
  readDraft,
  removeDraft,
  setDraftShared,
  writeDraftFile,
  type DraftContext,
  type DraftFailure,
} from "../skills/drafts/service.js";
import { listVisibleDrafts, readFile, visibleDraft } from "../skills/drafts/records.js";
import { withTeam } from "@kobe/db";
import { skillJson, versionJson } from "./skill-json.js";

type Ctx = Context<{ Variables: TeamVariables }>;
type Status = 400 | 403 | 404 | 409 | 413 | 422 | 428 | 429 | 503;

const error = (c: Ctx, status: Status, code: string, message: string, extra = {}) =>
  c.json({ code, message, ...extra }, status);

const idSchema = z.uuid();
const NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const createSchema = z.strictObject({ name: z.string().regex(NAME) });
const patchSchema = z.strictObject({ shared: z.boolean() });
const saveSchema = z.strictObject({
  destination: z.enum(["team", "personal"]),
  semver: semverSchema,
  changelog: changelogSchema,
  confirmPersonal: z.boolean().optional(),
});

const draftJson = (d: DraftRecord, viewerId: string) => ({
  id: d.id,
  name: d.name,
  shared: d.shared,
  mine: d.ownerUserId === viewerId,
  ownerUserId: d.ownerUserId,
  startedFrom: d.startedFrom,
  parentRef: d.parentRef,
  fromConversation: d.fromThreadId !== null,
  rev: d.rev,
  sizeBytes: d.sizeBytes,
  fileCount: d.fileCount,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  updatedBy: d.updatedBy,
});

const fileJson = (f: DraftFileInfo) => ({
  path: f.path,
  size: f.size,
  kind: f.kind,
  updatedAt: f.updatedAt,
});

/** The revision in `If-Match` (`"7"`, `W/"7"` or `7`); null when absent or malformed. */
function ifMatch(c: Ctx): number | null {
  const raw = c.req.header("if-match")?.trim();
  const m = raw ? /^(?:W\/)?"?([1-9][0-9]{0,9})"?$/.exec(raw) : null;
  const rev = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(rev) && rev <= 2147483647 ? rev : null;
}

/** The file path after `/<id>/files/`, decoded segment by segment. */
function filePath(c: Ctx, id: string): string | null {
  const pathname = new URL(c.req.url).pathname;
  const marker = `/${id}/files/`;
  const at = pathname.indexOf(marker);
  return at < 0 ? null : pathFromUrl(pathname.slice(at + marker.length));
}

/**
 * Workbench drafts (KOBE-320, spec SK11) in the active team. `POST /` starts a blank draft;
 * `GET /` lists the caller's drafts and, for Builders and Team admins, the team's shared ones;
 * `GET /:id` and `GET /:id/files/<path>` read; `PUT` and `DELETE /:id/files/<path>` and
 * `PATCH /:id` (`shared`) change it under `If-Match: <rev>` (missing: 428; stale: 409 with who
 * changed it); `DELETE /:id` removes it (author only); `POST /:id/versions` saves it as a version
 * (destination team or personal, semver, changelog). A draft the caller may not see is a 404.
 */
export function skillDraftRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  let made: SkillStore | null | undefined;
  const skillStore = (): SkillStore | null =>
    (made ??= deps.blobs ? new PostgresSkillStore(db, deps.blobs) : null);
  app.use(requireTeam(deps));

  const ctxOf = (c: Ctx): DraftContext => ({
    db,
    teamId: c.get("team").id,
    viewer: { userId: c.get("user").id, role: c.get("team").role },
  });

  const failure = (c: Ctx, f: DraftFailure) => {
    switch (f.error) {
      case "not_found":
        return error(c, 404, "not_found", "No such draft or file.");
      case "forbidden":
        return error(c, 403, "forbidden", f.message);
      case "stale_revision":
        return error(
          c,
          409,
          "stale_revision",
          `This draft was changed by ${f.changedBy.name}. Reload it to see their changes.`,
          { rev: f.rev, changedBy: f.changedBy },
        );
      case "invalid_path":
        return error(c, 400, "invalid_path", f.message);
      case "too_many_files":
        return error(c, 422, f.error, `A draft may have at most ${DRAFT_LIMITS.maxFiles} files.`);
      case "draft_limit":
        return error(
          c,
          422,
          f.error,
          `You have ${DRAFT_LIMITS.maxDraftsPerAuthor} drafts in this team. Delete one first.`,
        );
      case "draft_too_large":
      case "file_too_large":
        return error(c, 413, f.error, f.message);
    }
  };

  const json = async (c: Ctx): Promise<unknown> => c.req.json().catch(() => undefined);

  app.post("/", async (c) => {
    const body = createSchema.safeParse(await json(c));
    if (!body.success)
      return error(c, 400, "invalid_request", "Give a name: lowercase letters, digits, hyphens.");
    const result = await createBlankDraft(ctxOf(c), body.data.name);
    if (!result.ok) return failure(c, result);
    return c.json({ draft: draftJson(result.draft, c.get("user").id) }, 201);
  });

  app.get("/", async (c) => {
    const ctx = ctxOf(c);
    const drafts = await withTeam(db, ctx.teamId, (tx) =>
      listVisibleDrafts(tx, ctx.teamId, ctx.viewer),
    );
    return c.json({ drafts: drafts.map((d) => draftJson(d, ctx.viewer.userId)) });
  });

  app.get("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const found = id.success ? await readDraft(ctxOf(c), id.data) : null;
    if (!found) return error(c, 404, "not_found", "No such draft.");
    c.header("ETag", `"${found.draft.rev}"`);
    return c.json({
      draft: draftJson(found.draft, c.get("user").id),
      files: found.files.map(fileJson),
    });
  });

  app.patch("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    const rev = ifMatch(c);
    if (rev === null) return error(c, 428, "precondition_required", "Send If-Match: <rev>.");
    const body = patchSchema.safeParse(await json(c));
    if (!body.success) return error(c, 400, "invalid_request", "Give shared: true or false.");
    const result = await setDraftShared(ctxOf(c), id.data, rev, body.data.shared);
    if (!result.ok) return failure(c, result);
    return c.json({ draft: draftJson(result.draft, c.get("user").id) });
  });

  app.delete("/:id", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    const result = await removeDraft(ctxOf(c), id.data);
    if (!result.ok) return failure(c, result);
    return c.body(null, 204);
  });

  app.get("/:id/files/*", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const path = id.success ? filePath(c, id.data) : null;
    if (!id.success || path === null) return error(c, 404, "not_found", "No such file.");
    const ctx = ctxOf(c);
    const found = await withTeam(db, ctx.teamId, async (tx) => {
      const draft = await visibleDraft(tx, ctx.teamId, id.data, ctx.viewer);
      const file = draft ? await readFile(tx, ctx.teamId, id.data, path) : null;
      return draft && file ? { draft, file } : null;
    });
    if (!found) return error(c, 404, "not_found", "No such file.");
    return new Response(found.file.bytes, {
      status: 200,
      headers: {
        "content-type":
          found.file.kind === "text" ? "text/plain; charset=utf-8" : "application/octet-stream",
        "content-length": String(found.file.bytes.length),
        etag: `"${found.draft.rev}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "cache-control": "private, no-store",
      },
    });
  });

  const fileChange = async (c: Ctx, write: Uint8Array | null) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const path = id.success ? filePath(c, id.data) : null;
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    if (path === null) return error(c, 400, "invalid_path", "That file path doesn't decode.");
    const rev = ifMatch(c);
    if (rev === null) return error(c, 428, "precondition_required", "Send If-Match: <rev>.");
    if (!(await hitRateLimit(db, `skill-draft-write:${c.get("user").id}`, DRAFT_WRITE_RATE)))
      return error(c, 429, "rate_limited", "Too many changes. Wait a few minutes and try again.");
    const result =
      write === null
        ? await deleteDraftFile(ctxOf(c), id.data, rev, path)
        : await writeDraftFile(ctxOf(c), id.data, rev, path, write);
    if (!result.ok) return failure(c, result);
    c.header("ETag", `"${result.draft.rev}"`);
    return c.json({ rev: result.draft.rev, draft: draftJson(result.draft, c.get("user").id) });
  };

  app.put(
    "/:id/files/*",
    bodyLimit({
      maxSize: DRAFT_LIMITS.maxDraftBytes,
      onError: (c) =>
        c.json(
          {
            code: "draft_too_large",
            message: `A draft may hold at most ${DRAFT_LIMITS.maxDraftBytes} bytes in all.`,
          },
          413,
        ),
    }),
    async (c) => fileChange(c, new Uint8Array(await c.req.arrayBuffer())),
  );

  app.delete("/:id/files/*", (c) => fileChange(c, null));

  app.post("/:id/versions", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    const body = saveSchema.safeParse(await json(c));
    if (!body.success)
      return error(
        c,
        400,
        "invalid_request",
        "Give destination (team or personal), semver (MAJOR.MINOR.PATCH) and a changelog line.",
      );
    const header = c.req.header("if-match");
    const rev = header === undefined ? undefined : ifMatch(c);
    if (rev === null) return error(c, 400, "invalid_request", "If-Match must be a revision.");
    const store = skillStore();
    if (!store) return error(c, 503, "skills_unavailable", "Skill storage is not configured.");
    if (!(await hitRateLimit(db, `skill-upload:${c.get("user").id}`, SKILL_UPLOAD_RATE)))
      return error(c, 429, "rate_limited", "Too many uploads. Wait a few minutes and try again.");
    const result = await saveDraftVersion(
      { ...ctxOf(c), teamName: c.get("team").name },
      store,
      id.data,
      {
        destination: body.data.destination,
        semver: body.data.semver,
        changelog: body.data.changelog,
        confirmPersonal: body.data.confirmPersonal ?? false,
        ...(rev === undefined ? {} : { rev }),
      },
    );
    if (!result.ok) {
      if ("retryAfter" in result && result.retryAfter !== undefined)
        c.header("Retry-After", String(result.retryAfter));
      return error(
        c,
        result.status,
        result.code,
        result.message,
        "extra" in result ? result.extra : {},
      );
    }
    const review =
      body.data.destination === "team"
        ? { status: "pending", flagged: result.scan.findings.length > 0 }
        : null;
    return c.json(
      { skill: skillJson(result.skill), version: versionJson(result.version, review) },
      201,
    );
  });

  return app;
}
