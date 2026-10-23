import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { hitRateLimit } from "../rate-limit.js";
import {
  DRAFT_LIMITS,
  DRAFT_PREVIEW_RATE,
  DRAFT_WRITE_RATE,
  pathFromUrl,
} from "../skills/drafts/files.js";
import { changelogSchema, semverSchema } from "../skills/semver.js";
import {
  siteSkillView,
  siteVersionFile,
  siteVersionView,
} from "../skills/site-edit/catalog-view.js";
import { compareWithKobe, resetToKobe, type KobeDeps } from "../skills/site-edit/kobe-detach.js";
import {
  deleteSiteDraftFile,
  discardSiteDraft,
  draftFile,
  draftFiles,
  draftOf,
  startSiteDraft,
  writeRoom,
  writeSiteDraftFile,
  type SiteDraftFailure,
  type SiteDraftRecord,
} from "../skills/site-edit/site-drafts.js";
import { notifyMaintainers } from "../skills/site-edit/site-notify.js";
import { previewSiteDraft, suggestSiteBump } from "../skills/site-edit/site-preview.js";
import { publishSiteDraft, type PublishFailure } from "../skills/site-edit/site-publish.js";
import { readBounded } from "./skill-drafts.js";

type Ctx = Context<{ Variables: AuthVariables }>;
type Status = 400 | 403 | 404 | 409 | 413 | 422 | 428 | 429 | 503;

const error = (c: Ctx, status: Status, code: string, message: string, extra = {}) =>
  c.json({ code, message, ...extra }, status);

const idSchema = z.uuid();
const startSchema = z.strictObject({ versionId: z.uuid(), replace: z.boolean().optional() });
const publishSchema = z.strictObject({ semver: semverSchema, changelog: changelogSchema });

/** The revision in `If-Match` (`"7"`, `W/"7"` or `7`); null when absent or malformed. */
function ifMatch(c: Ctx): number | null {
  const raw = c.req.header("if-match")?.trim();
  const m = raw ? /^(?:W\/)?"?([1-9][0-9]{0,9})"?$/.exec(raw) : null;
  const rev = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(rev) && rev <= 2147483647 ? rev : null;
}

/** The file path after `marker` in the URL, decoded segment by segment. */
function pathAfter(c: Ctx, marker: string): string | null {
  const pathname = new URL(c.req.url).pathname;
  const at = pathname.indexOf(marker);
  return at < 0 ? null : pathFromUrl(pathname.slice(at + marker.length));
}

const draftJson = (d: SiteDraftRecord) => ({
  id: d.id,
  skillId: d.skillId,
  baseVersionId: d.baseVersionId,
  rev: d.rev,
  sizeBytes: d.sizeBytes,
  fileCount: d.fileCount,
  updatedAt: d.updatedAt,
  updatedBy: d.updatedBy,
});

/**
 * The Site Console's catalog skill view and editor (KOBE-495), at
 * `/v1/site/skills/catalog-skills/:skillId`: `GET /` the skill (versions, Kobe state, draft),
 * `GET /versions/:id` and `/versions/:id/files/<path>` one version; the site draft at `/draft`
 * (`POST` starts it from a version, `GET`, `DELETE`, `/files/<path>` read, `PUT`, `DELETE` under
 * `If-Match: <rev>`, `/scan`, `/bump`, `POST /publish`); a Kobe skill's `/kobe/compare` and
 * `POST /kobe/reset`. Site Owner and Admins only: the session's role per request, and the
 * services re-check it in the transaction that writes.
 */
export function siteSkillCatalogEditRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use("*", requireSitePermission("site.skills.catalog.manage"));
  const blobsOr = (_c: Ctx) => deps.blobs ?? null;
  const unavailable = (c: Ctx) =>
    error(c, 503, "skills_unavailable", "Skill storage is not configured.");
  const kobeDeps = (): KobeDeps | null =>
    deps.blobs ? { db, blobs: deps.blobs, log: logger } : null;

  const failure = (c: Ctx, f: SiteDraftFailure | PublishFailure) => {
    switch (f.error) {
      case "forbidden":
        return error(c, 403, "forbidden", "You don't have permission to do that.");
      case "not_found":
        return error(c, 404, "not_found", "No such catalog skill, version, draft or file.");
      case "retired":
        return error(
          c,
          409,
          "skill_retired",
          "This skill is deprecated or archived. Restore it before editing it.",
        );
      case "blocklisted":
        return error(
          c,
          422,
          "skill_blocklisted",
          "This skill's bytes are on the Site's blocklist. Unblock them before editing it.",
        );
      case "not_stored":
        return error(c, 409, "not_stored", "That version's files are not in the store.");
      case "draft_exists":
        return error(
          c,
          409,
          "draft_exists",
          `A site draft of this skill exists (changed by ${f.draft.updatedBy}). Continue it or replace it.`,
          { draft: f.draft },
        );
      case "stale_revision":
        return error(
          c,
          409,
          "stale_revision",
          `This draft was changed by ${f.changedBy}. Reload it to see their changes.`,
          { rev: f.rev, changedBy: { name: f.changedBy } },
        );
      case "too_many_files":
        return error(c, 422, f.error, `A draft may have at most ${DRAFT_LIMITS.maxFiles} files.`);
      case "invalid_path":
        return error(c, 400, "invalid_path", f.message);
      case "file_too_large":
      case "draft_too_large":
        return error(c, 413, f.error, f.message);
      case "skill_md_missing":
      case "invalid_package":
      case "name_changed":
        return error(c, 422, f.error, f.message);
      case "semver_not_increasing":
        return error(c, 409, f.error, f.message);
      case "scan_busy":
        c.header("Retry-After", String(f.retryAfter ?? 10));
        return error(c, 429, "scan_busy", f.message);
      case "scan_block": {
        const { verdict, findings, scripts, skipped } = f.scan;
        return error(c, 422, "scan_block", f.message, {
          scan: { verdict, findings, scripts, skipped },
        });
      }
    }
  };

  const skillId = (c: Ctx) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    return id.success ? id.data : null;
  };

  app.get("/:skillId", async (c) => {
    const id = skillId(c);
    const view = id ? await siteSkillView(db, id) : null;
    if (!view) return error(c, 404, "not_found", "No such catalog skill.");
    return c.json(view);
  });

  app.get("/:skillId/versions/:versionId", async (c) => {
    const id = skillId(c);
    const version = idSchema.safeParse(c.req.param("versionId"));
    const blobs = blobsOr(c);
    if (!blobs) return unavailable(c);
    if (!id || !version.success) return error(c, 404, "not_found", "No such version.");
    const view = await siteVersionView(db, blobs, id, version.data);
    if (!view) return error(c, 404, "not_found", "No such version.");
    return c.json(view);
  });

  app.get("/:skillId/versions/:versionId/files/*", async (c) => {
    const id = skillId(c);
    const version = idSchema.safeParse(c.req.param("versionId"));
    const blobs = blobsOr(c);
    if (!blobs) return unavailable(c);
    if (!id || !version.success) return error(c, 404, "not_found", "No such file.");
    const path = pathAfter(c, `/versions/${version.data}/files/`);
    const file = path ? await siteVersionFile(db, blobs, id, version.data, path) : null;
    if (!file) return error(c, 404, "not_found", "No such file.");
    c.header("cache-control", "private, no-store");
    return c.json(file);
  });

  app.post("/:skillId/draft", async (c) => {
    const id = skillId(c);
    const blobs = blobsOr(c);
    if (!blobs) return unavailable(c);
    const body = startSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!id) return error(c, 404, "not_found", "No such catalog skill.");
    if (!body.success) return error(c, 400, "invalid_request", "Give the version to start from.");
    const r = await startSiteDraft(
      { db, blobs },
      c.get("user").id,
      id,
      body.data.versionId,
      body.data.replace === true,
    );
    if (!r.ok) return failure(c, r);
    c.header("ETag", `"${r.draft.rev}"`);
    return c.json({ draft: draftJson(r.draft), files: await draftFiles(db, r.draft.id) }, 201);
  });

  app.get("/:skillId/draft", async (c) => {
    const id = skillId(c);
    const draft = id ? await draftOf(db, id) : null;
    if (!draft) return error(c, 404, "not_found", "This skill has no site draft.");
    c.header("ETag", `"${draft.rev}"`);
    return c.json({ draft: draftJson(draft), files: await draftFiles(db, draft.id) });
  });

  app.delete("/:skillId/draft", async (c) => {
    const id = skillId(c);
    if (!id) return error(c, 404, "not_found", "This skill has no site draft.");
    const r = await discardSiteDraft(db, c.get("user").id, id);
    return r.ok ? c.body(null, 204) : failure(c, r);
  });

  app.get("/:skillId/draft/files/*", async (c) => {
    const id = skillId(c);
    const draft = id ? await draftOf(db, id) : null;
    const path = draft ? pathAfter(c, "/draft/files/") : null;
    const file = draft && path !== null ? await draftFile(db, draft.id, path) : null;
    if (!draft || !file) return error(c, 404, "not_found", "No such file.");
    return new Response(file.bytes, {
      status: 200,
      headers: {
        "content-type":
          file.kind === "text" ? "text/plain; charset=utf-8" : "application/octet-stream",
        "content-length": String(file.bytes.length),
        etag: `"${draft.rev}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "cache-control": "private, no-store",
      },
    });
  });

  const fileChange = async (c: Ctx, mode: "put" | "delete") => {
    const id = skillId(c);
    if (!id) return error(c, 404, "not_found", "This skill has no site draft.");
    const path = pathAfter(c, "/draft/files/");
    if (path === null) return error(c, 400, "invalid_path", "That file path doesn't decode.");
    const rev = ifMatch(c);
    if (rev === null) return error(c, 428, "precondition_required", "Send If-Match: <rev>.");
    const userId = c.get("user").id;
    if (!(await hitRateLimit(db, `skill-draft-write:${userId}`, DRAFT_WRITE_RATE)))
      return error(c, 429, "rate_limited", "Too many changes. Wait a few minutes and try again.");
    let r;
    if (mode === "delete") r = await deleteSiteDraftFile(db, userId, id, rev, path);
    else {
      const room = await writeRoom(db, id, path);
      if (!room) return error(c, 404, "not_found", "This skill has no site draft.");
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
      r = await writeSiteDraftFile(db, userId, id, rev, path, body);
    }
    if (!r.ok) return failure(c, r);
    c.header("ETag", `"${r.draft.rev}"`);
    return c.json({ rev: r.draft.rev, draft: draftJson(r.draft) });
  };
  app.put("/:skillId/draft/files/*", (c) => fileChange(c, "put"));
  app.delete("/:skillId/draft/files/*", (c) => fileChange(c, "delete"));

  const previewAllowed = (c: Ctx) =>
    hitRateLimit(db, `skill-draft-preview:${c.get("user").id}`, DRAFT_PREVIEW_RATE);

  app.get("/:skillId/draft/scan", async (c) => {
    const id = skillId(c);
    if (!id) return error(c, 404, "not_found", "This skill has no site draft.");
    c.header("cache-control", "private, no-store");
    if (!(await previewAllowed(c)))
      return error(c, 429, "rate_limited", "Too many scans. Wait a few minutes and try again.");
    const r = await previewSiteDraft(db, id, c.get("user").id, c.req.raw.signal);
    if (r.ok) {
      const { verdict, findings, scripts, skipped, ruleSetVersion } = r.scan;
      return c.json({ rev: r.rev, verdict, findings, scripts, skipped, ruleSetVersion });
    }
    switch (r.error) {
      case "not_found":
        return error(c, 404, "not_found", "This skill has no site draft.");
      case "busy":
        c.header("Retry-After", "1");
        return error(c, 429, "scan_busy", "The scan preview is busy. It runs again shortly.");
      case "unavailable":
        c.header("Retry-After", "5");
        return error(c, 503, "scan_unavailable", "The scan preview couldn't finish just now.");
      case "package_problem":
        return error(c, 422, "invalid_package", r.message);
    }
  });

  app.get("/:skillId/draft/bump", async (c) => {
    const id = skillId(c);
    const blobs = blobsOr(c);
    if (!blobs) return unavailable(c);
    if (!(await previewAllowed(c)))
      return error(c, 429, "rate_limited", "Too many requests. Wait a few minutes and try again.");
    const bump = id ? await suggestSiteBump(db, blobs, id) : null;
    if (!bump) return error(c, 404, "not_found", "This skill has no site draft.");
    return c.json(bump);
  });

  app.post("/:skillId/draft/publish", async (c) => {
    const id = skillId(c);
    const blobs = blobsOr(c);
    if (!blobs) return unavailable(c);
    if (!id) return error(c, 404, "not_found", "This skill has no site draft.");
    const rev = ifMatch(c);
    if (rev === null) return error(c, 428, "precondition_required", "Send If-Match: <rev>.");
    const body = publishSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success)
      return error(c, 400, "invalid_request", "Give a semver (1.2.3) and a changelog.");
    const userId = c.get("user").id;
    const r = await publishSiteDraft({ db, blobs }, userId, id, { ...body.data, rev });
    if (!r.ok) return failure(c, r);
    const notified = await notifyMaintainers(db, r.published, userId).catch((err: unknown) => {
      logger.error({ err, skillId: id }, "skills: maintainers not told of a site version");
      return 0;
    });
    const { notifyTeamId: _team, ...published } = r.published;
    return c.json({ version: published, notified }, 201);
  });

  app.get("/:skillId/kobe/compare", async (c) => {
    const id = skillId(c);
    const k = kobeDeps();
    if (!k) return unavailable(c);
    if (!id) return error(c, 404, "not_found", "No such catalog skill.");
    const r = await compareWithKobe(k, id);
    if (r.ok) return c.json(r.compare);
    switch (r.code) {
      case "not_found":
        return error(c, 404, "not_found", "No such catalog skill.");
      case "not_kobe":
        return error(c, 409, "not_kobe", "Only Kobe's own skills compare with a shipped version.");
      case "not_shipped":
        return error(c, 409, "not_shipped", "This release of Kobe doesn't ship that skill.");
      case "not_stored":
        return error(c, 409, "not_stored", "The current version's files are not in the store.");
    }
  });

  app.post("/:skillId/kobe/reset", async (c) => {
    const id = skillId(c);
    const k = kobeDeps();
    if (!k) return unavailable(c);
    if (!id) return error(c, 404, "not_found", "No such catalog skill.");
    const r = await resetToKobe(k, id, c.get("user").id);
    if (r.ok) return c.json({ shippedSemver: r.shippedSemver, seed: r.seed });
    switch (r.code) {
      case "forbidden":
        return error(c, 403, "forbidden", "You don't have permission to do that.");
      case "not_found":
        return error(c, 404, "not_found", "No such catalog skill.");
      case "not_kobe":
        return error(c, 409, "not_kobe", "Only Kobe's own skills reset to Kobe.");
      case "not_detached":
        return error(c, 409, "not_detached", "This skill already follows Kobe's shipped version.");
      case "not_shipped":
        return error(c, 409, "not_shipped", "This release of Kobe doesn't ship that skill.");
      case "shipped_not_above":
        return error(
          c,
          409,
          "shipped_not_above",
          `Kobe ships ${r.shippedSemver}, which is not above the Site's ${r.siteSemver}: the skill stays detached until Kobe ships a higher version.`,
          { shippedSemver: r.shippedSemver, siteSemver: r.siteSemver },
        );
    }
  });

  return app;
}
