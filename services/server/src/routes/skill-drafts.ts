import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireTeam, type TeamVariables } from "../authz/middleware.js";
import { teamRoleAllows } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import { hitRateLimit } from "../rate-limit.js";
import { SKILL_UPLOAD_RATE } from "../skills/limits.js";
import { PostgresSkillStore, type SkillStore } from "../skills/skill-store.js";
import { changelogSchema, semverSchema } from "../skills/semver.js";
import {
  DRAFT_LIMITS,
  DRAFT_PREVIEW_RATE,
  DRAFT_WRITE_RATE,
  pathFromUrl,
} from "../skills/drafts/files.js";
import { previewDraftScan } from "../skills/drafts/scan-preview.js";
import { suggestDraftBump } from "../skills/drafts/suggest.js";
import type { DraftFileInfo, DraftRecord } from "../skills/drafts/records.js";
import { saveDraftVersion } from "../skills/drafts/save.js";
import {
  writeRoom,
  createBlankDraft,
  deleteDraftFile,
  readDraft,
  removeDraft,
  setDraftShared,
  writeDraftFile,
  type DraftContext,
  type DraftFailure,
} from "../skills/drafts/service.js";
import { deleteDraftBundles } from "../skills/drafts/test-holds.js";
import { logger } from "../logger.js";
import {
  listVisibleDrafts,
  readFile,
  visibleDraft,
  type DraftCursor,
} from "../skills/drafts/records.js";
import { withTeam } from "@kobe/db";
import { bodyLimit } from "hono/body-limit";
import { SKILL_LIMITS } from "../skills/limits.js";
import { startFromTemplate, startFromUpload, type StartResult } from "../skills/drafts/starts.js";
import { TEMPLATE_IDS, templates } from "../skills/drafts/templates.js";
import { saveWorkspaceSkill } from "../skills/drafts/from-workspace.js";
import { startFork } from "../skills/drafts/fork.js";
import type { WorkspaceSync } from "../workspace-sync/index.js";
import { skillJson, versionJson } from "./skill-json.js";

type Ctx = Context<{ Variables: TeamVariables }>;
type Status = 400 | 403 | 404 | 409 | 413 | 422 | 428 | 429 | 503;

const error = (c: Ctx, status: Status, code: string, message: string, extra = {}) =>
  c.json({ code, message, ...extra }, status);

const idSchema = z.uuid();
const NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const createSchema = z.strictObject({
  name: z.string().regex(NAME),
  template: z.enum(TEMPLATE_IDS).optional(),
});
const patchSchema = z.strictObject({ shared: z.boolean() });
const destinationSchema = z.enum(["team", "personal"]);
const forkSchema = z.strictObject({
  source: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.enum(["team", "personal"]),
      skillId: z.uuid(),
      version: z.number().int().positive().optional(),
    }),
    z.strictObject({
      kind: z.literal("catalog"),
      skillId: z.uuid(),
      semver: semverSchema.optional(),
    }),
  ]),
  name: z.string().regex(NAME).optional(),
});
const fromWorkspaceSchema = z.strictObject({ threadId: z.uuid(), folder: z.string().regex(NAME) });
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
  fromConversation: d.startedFrom === "thread",
  coEdited: d.coEdited,
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
 * (destination team or personal, semver, changelog). `GET /:id/scan` is the live scan preview
 * and `GET /:id/bump?destination=` the suggested semver bump (KOBE-321). A draft the caller may
 * not see is a 404.
 */
export function skillDraftRoutes(
  deps: ServerDeps,
  /** The workspace store (Save to Workbench reads the caller's `/workspace/skills/<name>/`). */
  workspace?: WorkspaceSync,
): Hono<{ Variables: TeamVariables }> {
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

  const mayStart = (c: Ctx) => teamRoleAllows(c.get("team").role, "team.personal.create");
  const NO_DRAFTS = "Your team role doesn't allow drafts.";
  const started = (c: Ctx, result: StartResult) => {
    if (result.ok) return c.json({ draft: draftJson(result.draft, c.get("user").id) }, 201);
    if (result.error === "invalid_bundle")
      return error(
        c,
        result.bundle.code === "bundle_too_large" || result.bundle.code === "file_too_large"
          ? 413
          : 400,
        result.bundle.code,
        result.bundle.message,
      );
    return failure(c, result);
  };

  // A blank draft, or one from a template (KOBE-322, SK10).
  app.post("/", async (c) => {
    if (!mayStart(c)) return error(c, 403, "forbidden", NO_DRAFTS);
    const body = createSchema.safeParse(await json(c));
    if (!body.success)
      return error(
        c,
        400,
        "invalid_request",
        "Give a name (lowercase letters, digits, hyphens) and, optionally, a template.",
      );
    const { name, template } = body.data;
    return started(
      c,
      template
        ? await startFromTemplate(ctxOf(c), template, name)
        : await createBlankDraft(ctxOf(c), name),
    );
  });

  // Fork (KOBE-322): a copy of a team, own personal or installed catalog version; the parent is
  // recorded from the version copied. Forking a skill under its own name is how it is edited.
  app.post("/fork", async (c) => {
    if (!mayStart(c)) return error(c, 403, "forbidden", NO_DRAFTS);
    const body = forkSchema.safeParse(await json(c));
    if (!body.success)
      return error(
        c,
        400,
        "invalid_request",
        "Give source {kind, skillId, version or semver} and, optionally, a name.",
      );
    const store = skillStore();
    if (!store || !deps.blobs)
      return error(c, 503, "skills_unavailable", "Skill storage is not configured.");
    // A fork reads, verifies and unzips a package: the same rate as the other heavy starts.
    if (!(await hitRateLimit(db, `skill-upload:${c.get("user").id}`, SKILL_UPLOAD_RATE)))
      return error(c, 429, "rate_limited", "Too many copies. Wait a few minutes and try again.");
    const result = await startFork(
      ctxOf(c),
      { store, blobs: deps.blobs },
      body.data.source,
      body.data.name,
    );
    if (!result.ok && result.error === "source_not_found")
      return error(c, 404, "not_found", "No such skill version to copy.");
    if (!result.ok && result.error === "source_unavailable")
      return error(c, 409, "source_unavailable", "That version's files can't be copied yet.");
    if (!result.ok && result.error === "blocklisted")
      return error(c, 422, "skill_blocklisted", "That version is on the site's blocklist.");
    return started(c, result as StartResult);
  });

  // Save to Workbench (KOBE-322): `/workspace/skills/<folder>/` from a conversation of this team.
  app.post("/from-workspace", async (c) => {
    if (!mayStart(c)) return error(c, 403, "forbidden", NO_DRAFTS);
    if (!workspace)
      return error(c, 503, "workspace_unavailable", "Workspace files are not available here.");
    const body = fromWorkspaceSchema.safeParse(await json(c));
    if (!body.success)
      return error(c, 400, "invalid_request", "Give threadId and folder (a skill name).");
    if (!(await hitRateLimit(db, `skill-upload:${c.get("user").id}`, SKILL_UPLOAD_RATE)))
      return error(c, 429, "rate_limited", "Too many saves. Wait a few minutes and try again.");
    const result = await saveWorkspaceSkill(ctxOf(c), workspace, body.data);
    if (!result.ok && result.error === "thread_not_found")
      return error(c, 404, "not_found", "No such conversation.");
    if (!result.ok && result.error === "folder_empty")
      return error(
        c,
        404,
        "folder_empty",
        `/workspace/skills/${body.data.folder}/ has no saved files yet.`,
      );
    if (!result.ok && result.error === "folder_changed")
      return error(c, 409, "folder_changed", "The folder changed while saving. Save again.");
    if (result.ok && result.created === false)
      return c.json({ draft: draftJson(result.draft, c.get("user").id), created: false });
    return started(c, result as StartResult);
  });

  app.get("/templates", (c) =>
    c.json({
      templates: templates().map(({ id, title, summary }) => ({ id, title, summary })),
    }),
  );

  // An uploaded zip or SKILL.md (KOBE-322): the upload's validation, then the draft's limits.
  app.post(
    "/upload",
    bodyLimit({
      maxSize: SKILL_LIMITS.maxBundleBytes,
      onError: (c) =>
        c.json({ code: "bundle_too_large", message: "That skill is too large." }, 413),
    }),
    async (c) => {
      if (!mayStart(c)) return error(c, 403, "forbidden", NO_DRAFTS);
      const kind = z.enum(["zip", "skill_md"]).safeParse(c.req.query("kind"));
      if (!kind.success) return error(c, 400, "invalid_request", "Give kind=zip or kind=skill_md.");
      if (!(await hitRateLimit(db, `skill-upload:${c.get("user").id}`, SKILL_UPLOAD_RATE)))
        return error(c, 429, "rate_limited", "Too many uploads. Wait a few minutes and try again.");
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return started(c, await startFromUpload(ctxOf(c), bytes, kind.data));
    },
  );

  app.get("/", async (c) => {
    const ctx = ctxOf(c);
    const raw = c.req.query("cursor");
    const cursor = raw === undefined ? null : decodeCursor(raw);
    if (cursor === undefined) return error(c, 400, "invalid_request", "That cursor is not valid.");
    const page = await withTeam(db, ctx.teamId, (tx) =>
      listVisibleDrafts(tx, ctx.teamId, ctx.viewer, cursor),
    );
    return c.json({
      drafts: page.drafts.map((d) => draftJson(d, ctx.viewer.userId)),
      next: page.next ? encodeCursor(page.next) : null,
    });
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
    const ctx = ctxOf(c);
    const result = await removeDraft(ctx, id.data);
    if (!result.ok) return failure(c, result);
    // Its test bundles (KOBE-323) go too; the retention pass sweeps any a failure here left.
    if (deps.blobs)
      await deleteDraftBundles(db, deps.blobs, ctx.teamId, id.data).catch((err: unknown) =>
        logger.warn({ err, draftId: id.data }, "skill drafts: test bundles not deleted yet"),
      );
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

  /**
   * A file write or delete. Everything that can refuse it (path, If-Match, the rate, whether the
   * caller may edit the draft, the room left) is checked before a byte of the body is read, and the
   * body is read only up to that room (review S3); the write checks again under the draft's lock.
   */
  const fileChange = async (c: Ctx, mode: "put" | "delete") => {
    const id = idSchema.safeParse(c.req.param("id"));
    const path = id.success ? filePath(c, id.data) : null;
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    if (path === null) return error(c, 400, "invalid_path", "That file path doesn't decode.");
    const rev = ifMatch(c);
    if (rev === null) return error(c, 428, "precondition_required", "Send If-Match: <rev>.");
    if (!(await hitRateLimit(db, `skill-draft-write:${c.get("user").id}`, DRAFT_WRITE_RATE)))
      return error(c, 429, "rate_limited", "Too many changes. Wait a few minutes and try again.");
    const ctx = ctxOf(c);
    if (mode === "delete") return changed(c, await deleteDraftFile(ctx, id.data, rev, path));
    const room = await writeRoom(ctx, id.data, path);
    if (!room.ok) return failure(c, room);
    const body = await readBounded(c.req.raw, Math.max(room.room, 0));
    if (body === null)
      return room.skillMd
        ? error(
            c,
            413,
            "file_too_large",
            `SKILL.md may be at most ${DRAFT_LIMITS.maxSkillMdBytes} bytes.`,
          )
        : error(
            c,
            413,
            "draft_too_large",
            `A draft may hold at most ${DRAFT_LIMITS.maxDraftBytes} bytes in all.`,
          );
    return changed(c, await writeDraftFile(ctx, id.data, rev, path, body));
  };

  const changed = (
    c: Ctx,
    result: Awaited<ReturnType<typeof writeDraftFile>>,
  ): Response | Promise<Response> => {
    if (!result.ok) return failure(c, result);
    c.header("ETag", `"${result.draft.rev}"`);
    return c.json({ rev: result.draft.rev, draft: draftJson(result.draft, c.get("user").id) });
  };

  app.put("/:id/files/*", (c) => fileChange(c, "put"));
  app.delete("/:id/files/*", (c) => fileChange(c, "delete"));

  const previewAllowed = (c: Ctx) =>
    hitRateLimit(db, `skill-draft-preview:${c.get("user").id}`, DRAFT_PREVIEW_RATE);

  // The live scan preview (SK12): the verdict tier and findings of the draft as stored now. Only
  // a request that needs a new scan counts against the rate (review S3).
  app.get("/:id/scan", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    const result = await previewDraftScan(ctxOf(c), id.data, {
      admit: () => previewAllowed(c),
      signal: c.req.raw.signal,
    });
    c.header("cache-control", "private, no-store");
    if (result.ok) {
      c.header("ETag", `"${result.rev}"`);
      const { verdict, findings, scripts, skipped, ruleSetVersion } = result.scan;
      return c.json({ rev: result.rev, verdict, findings, scripts, skipped, ruleSetVersion });
    }
    switch (result.error) {
      case "not_found":
        return error(c, 404, "not_found", "No such draft.");
      case "rate_limited":
        return error(c, 429, "rate_limited", "Too many scans. Wait a few minutes and try again.");
      case "busy":
        // Scans are busy or a newer request took this one's place: ask again in a second.
        c.header("Retry-After", "1");
        return error(c, 429, "scan_busy", "The scan preview is busy. It runs again shortly.");
      case "unavailable":
        c.header("Retry-After", "5");
        return error(
          c,
          503,
          "scan_unavailable",
          "The scan preview couldn't finish just now. It tries again; saving scans the draft in full.",
        );
      case "package_problem":
        return error(c, 422, "invalid_package", result.message);
    }
  });

  // The bump Save version suggests (SK14) against the destination's latest version.
  app.get("/:id/bump", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return error(c, 404, "not_found", "No such draft.");
    const destination = destinationSchema.safeParse(c.req.query("destination"));
    if (!destination.success)
      return error(c, 400, "invalid_request", "Give destination=team or destination=personal.");
    const store = skillStore();
    if (!store) return error(c, 503, "skills_unavailable", "Skill storage is not configured.");
    if (!(await previewAllowed(c)))
      return error(c, 429, "rate_limited", "Too many requests. Wait a few minutes and try again.");
    const result = await suggestDraftBump(ctxOf(c), store, id.data, destination.data);
    if (!result.ok)
      return result.error === "not_found"
        ? error(c, 404, "not_found", "No such draft.")
        : error(c, 503, "skills_unavailable", "The latest version can't be read right now.");
    const { rev, latest, kind, suggested, reasons } = result;
    return c.json({ rev, latest, kind, suggested, reasons });
  });

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
    // Saves carry the revision the author saw (SK11): nobody ships a co-editor's unseen change.
    const rev = ifMatch(c);
    if (rev === null) return error(c, 428, "precondition_required", "Send If-Match: <rev>.");
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
        rev,
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

/** Reads the body up to `max` bytes; null when it (or its declared length) is longer. */
async function readBounded(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= max)) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const encodeCursor = (c: DraftCursor): string =>
  Buffer.from(`${c.updatedAt}|${c.id}`).toString("base64url");

/** The cursor of `GET /?cursor=`; undefined when malformed. */
function decodeCursor(raw: string): DraftCursor | undefined {
  const [at, id, extra] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
  if (
    extra !== undefined ||
    !at ||
    !instant.test(at) ||
    Number.isNaN(Date.parse(at)) ||
    !idSchema.safeParse(id).success
  )
    return undefined;
  return { updatedAt: at, id: id as string };
}
