import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireTeam, type TeamVariables } from "../authz/middleware.js";
import { teamRoleAllows } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import {
  bundleFromSkillMd,
  validateZipBundle,
  type BundleError,
  type ValidBundle,
} from "../skills/bundle.js";
import { hitRateLimit } from "../rate-limit.js";
import { SKILL_LIMITS, SKILL_UPLOAD_RATE } from "../skills/limits.js";
import { blockedAmong, isBlocked } from "../skills/blocklist.js";
import { recordAuditAfter } from "../audit/record.js";
import {
  ExportTooLargeError,
  exportResponse,
  exportZip,
  filesOfPackage,
  type Exported,
} from "../skills/export.js";
import { reviewsOfSkill } from "../skills/review.js";
import { numberingFrom, publishBundle } from "../skills/publish.js";
import { parseSemver } from "../skills/semver.js";
import { readUploadBody } from "../skills/upload-body.js";
import { IntegrityError } from "../skills/blob-read.js";
import { PostgresSkillStore, type SkillStore } from "../skills/skill-store.js";
import { logger } from "../logger.js";
import { skillJson, versionJson } from "./skill-json.js";
import {
  findSkill,
  getSkillVersion,
  listSkills,
  listSkillVersions,
  type SkillLocation,
  type SkillRecord,
  type SkillScope,
} from "../skills/store.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const scopeSchema = z.enum(["team", "personal"]);
const idSchema = z.uuid();
const seqSchema = z.coerce.number().int().positive().max(2147483647);
/** A version in a path: its number (seq) or its semver (KOBE-308). */
const versionRef = (value: string | undefined): number | string | null => {
  if (value !== undefined && parseSemver(value)) return value;
  const seq = seqSchema.safeParse(value);
  return seq.success ? seq.data : null;
};

const error = (
  c: Ctx,
  status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 503,
  code: string,
  message: string,
) => c.json({ code, message }, status);

const BLOCKLISTED_DOWNLOAD = "This skill version is on the site's blocklist and can't be opened.";

/**
 * Skill bundles (spec D19, §6.1, KOBE-78) from the active team's point of view: the team's skills
 * and the caller's personal ones. `POST /?scope=team|personal` takes a zip (or a bare SKILL.md as
 * text/markdown, or either as the `bundle` part of multipart/form-data) and stores it as the next
 * immutable version of the skill its frontmatter names, numbered `semver` (query or form field;
 * default: the next minor) with an optional `changelog` (form field only, KOBE-308);
 * `GET /`, `GET /:id`, `GET /:id/versions[/:n]` read them. Each upload is scanned (KOBE-80); a team
 * version starts `pending` review and is unusable until a team admin approves it.
 */
export function skillRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  // Records in Postgres, bytes in the object store (KOBE-310); none without an object store.
  // Made on first use: building the routes touches no dependency.
  let made: SkillStore | null | undefined;
  const skillStore = (): SkillStore | null =>
    (made ??= deps.blobs ? new PostgresSkillStore(db, deps.blobs) : null);
  app.use(requireTeam(deps));

  const locationFor = (c: Ctx, scope: SkillScope): SkillLocation =>
    scope === "team"
      ? { scope, teamId: c.get("team").id }
      : { scope, ownerUserId: c.get("user").id };

  /** The skill and where it lives, if the caller can see it (team first, then personal). */
  async function visible(c: Ctx): Promise<{ skill: SkillRecord; location: SkillLocation } | null> {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return null;
    for (const scope of ["team", "personal"] as const) {
      const location = locationFor(c, scope);
      const skill = await findSkill(db, location, id.data);
      if (skill) return { skill, location };
    }
    return null;
  }

  /** Review state per version number for a team skill; null for personal ones. */
  const reviewsFor = (c: Ctx, found: { skill: SkillRecord }) =>
    found.skill.scope === "team"
      ? reviewsOfSkill(db, c.get("team").id, found.skill.id)
      : Promise.resolve(null);

  app.get("/", async (c) => {
    const scope = c.req.query("scope");
    if (scope !== undefined && !scopeSchema.safeParse(scope).success)
      return error(c, 400, "invalid_request", "scope must be team or personal.");
    const scopes = scope ? [scope as SkillScope] : (["team", "personal"] as const);
    const lists = await Promise.all(scopes.map((s) => listSkills(db, locationFor(c, s))));
    return c.json({ skills: lists.flat().map(skillJson) });
  });

  app.post(
    "/",
    bodyLimit({
      maxSize: SKILL_LIMITS.maxBundleBytes,
      onError: (c) =>
        c.json({ code: "bundle_too_large", message: "That skill is too large." }, 413),
    }),
    async (c) => {
      const scope = scopeSchema.safeParse(c.req.query("scope"));
      if (!scope.success)
        return error(c, 400, "invalid_request", "Give scope=team or scope=personal.");
      const allowed = teamRoleAllows(
        c.get("team").role,
        scope.data === "team" ? "team.skills.publish" : "team.personal.create",
      );
      if (!allowed) return error(c, 403, "forbidden", "Your team role doesn't allow that upload.");
      const store = skillStore();
      if (!store) return error(c, 503, "skills_unavailable", "Skill storage is not configured.");
      if (!(await hitRateLimit(db, `skill-upload:${c.get("user").id}`, SKILL_UPLOAD_RATE)))
        return c.json(
          { code: "rate_limited", message: "Too many uploads. Wait a few minutes and try again." },
          429,
        );
      const read = await readUploadBody(c.req.raw, new URL(c.req.url).searchParams);
      if (!read.ok) return error(c, read.status, read.code, read.message);
      const numbering = read.body;
      const prepared =
        numbering.kind === "zip" ? prepareZip(numbering.bytes) : prepareMarkdown(numbering.bytes);
      if (!prepared.ok) return bundleError(c, prepared.error);
      const { bundle, source } = prepared;
      const requested = numberingFrom(numbering, bundle);
      if (!requested.ok) return error(c, 400, "invalid_request", requested.message);
      // The whole tree is scanned (SK32), evals/ fixtures included.
      const result = await publishBundle(store, locationFor(c, scope.data), {
        bundle,
        source,
        uploadedBy: c.get("user").id,
        ...requested.value,
      });
      if (!result.ok) {
        if (result.retryAfter !== undefined) c.header("Retry-After", String(result.retryAfter));
        return error(c, result.status, result.code, result.message);
      }
      const review =
        scope.data === "team"
          ? { status: "pending", flagged: result.scan.findings.length > 0 }
          : null;
      return c.json(
        { skill: skillJson(result.skill), version: versionJson(result.version, review) },
        201,
      );
    },
  );

  app.get("/:id", async (c) => {
    const found = await visible(c);
    if (!found) return error(c, 404, "not_found", "No such skill.");
    return c.json({ skill: skillJson(found.skill) });
  });

  app.get("/:id/versions", async (c) => {
    const found = await visible(c);
    if (!found) return error(c, 404, "not_found", "No such skill.");
    const store = skillStore();
    const versions = store
      ? await store.listVersions(found.location, found.skill.id)
      : await listSkillVersions(db, found.location, found.skill.id);
    const reviews = await reviewsFor(c, found);
    return c.json({
      versions: versions.map((v) => versionJson(v, reviews?.get(v.version) ?? null)),
    });
  });

  app.get("/:id/versions/:version", async (c) => {
    const found = await visible(c);
    const ref = versionRef(c.req.param("version"));
    if (!found || ref === null) return error(c, 404, "not_found", "No such skill version.");
    const version = await getSkillVersion(db, found.location, found.skill.id, ref);
    if (!version) return error(c, 404, "not_found", "No such skill version.");
    const reviews = await reviewsFor(c, found);
    return c.json({
      skill: skillJson(found.skill),
      version: versionJson(version, reviews?.get(version.version) ?? null),
    });
  });

  /** The stored canonical zip of one version, for the browser editor (KOBE-83). Reads are not audited. */
  app.get("/:id/versions/:version/bundle", async (c) => {
    const found = await visible(c);
    const ref = versionRef(c.req.param("version"));
    if (!found || ref === null) return error(c, 404, "not_found", "No such skill version.");
    const version = await getSkillVersion(db, found.location, found.skill.id, ref);
    if (!version) return error(c, 404, "not_found", "No such skill version.");
    if (await db.transaction((tx) => isBlocked(tx, version.contentHash)))
      return error(c, 422, "skill_blocklisted", BLOCKLISTED_DOWNLOAD);
    const store = skillStore();
    if (!store) return error(c, 503, "skills_unavailable", "Skill storage is not configured.");
    const opened = await store.openVersion(found.location, found.skill.id, version.version);
    if (!opened) return error(c, 404, "not_found", "That version's bundle is not available.");
    opened.body.on("error", (err) => {
      if (err instanceof IntegrityError)
        logger.error(
          { hash: version.contentHash, reason: err.reason },
          "skills: stored package is corrupt",
        );
    });
    return new Response(Readable.toWeb(opened.body) as ReadableStream, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": String(opened.size),
        "content-disposition": `attachment; filename="${found.skill.slug}-v${version.semver}.zip"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  });

  /**
   * A portable export (KOBE-345, SK30): `?format=portable` (the payload, SKILL.md and its files)
   * or `portable_evals` (with `evals/`), under one `<name>/` folder, deterministic bytes. Who sees
   * the skill may export it; a team version only once its team review approved it, and never a
   * blocklisted one. The full package (kobe.skill.yaml, provenance.json) is the catalog's.
   */
  app.get("/:id/versions/:version/export", async (c) => {
    const format = z.enum(["portable", "portable_evals"]).safeParse(c.req.query("format"));
    if (!format.success)
      return error(c, 400, "invalid_request", "Give format=portable or format=portable_evals.");
    const found = await visible(c);
    const ref = versionRef(c.req.param("version"));
    if (!found || ref === null) return error(c, 404, "not_found", "No such skill version.");
    const version = await getSkillVersion(db, found.location, found.skill.id, ref);
    if (!version) return error(c, 404, "not_found", "No such skill version.");
    const hashes = [version.contentHash, ...(version.packageHash ? [version.packageHash] : [])];
    if ((await db.transaction((tx) => blockedAmong(tx, hashes))).length > 0)
      return error(c, 422, "skill_blocklisted", BLOCKLISTED_DOWNLOAD);
    if (found.skill.scope === "team") {
      const review = (await reviewsFor(c, found))?.get(version.version);
      if (review?.status !== "approved")
        return error(
          c,
          409,
          "not_approved",
          "Only versions the team's review approved can be exported.",
        );
    }
    const store = skillStore();
    if (!store) return error(c, 503, "skills_unavailable", "Skill storage is not configured.");
    const [out] = await store.export(found.location, found.skill.id, {
      fromSeq: version.seq,
      toSeq: version.seq,
    });
    if (!out || !("bytes" in out))
      return error(c, 409, "legacy_version", "Save this version again to export it.");
    let exported: Exported;
    try {
      exported = exportZip(
        found.skill.slug,
        version.semver,
        filesOfPackage(out.bytes),
        format.data,
        null,
      );
    } catch (err) {
      if (err instanceof ExportTooLargeError) return error(c, 413, "too_large", err.message);
      throw err;
    }
    await recordAuditAfter(db, {
      action: "skill.exported",
      teamId: found.skill.scope === "team" ? c.get("team").id : null,
      target: {
        scope: found.skill.scope,
        skillId: found.skill.id,
        name: found.skill.slug,
        semver: version.semver,
        format: format.data,
        sha256: exported.sha256,
      },
    });
    return exportResponse(exported);
  });

  return app;
}

type Prepared =
  | {
      ok: true;
      source: "zip" | "skill_md";
      bundle: ValidBundle;
    }
  | { ok: false; error: BundleError };

function prepareZip(bytes: Uint8Array): Prepared {
  const result = validateZipBundle(bytes);
  return result.ok
    ? { ok: true, source: "zip", bundle: result.value }
    : { ok: false, error: result.error };
}

function prepareMarkdown(bytes: Uint8Array): Prepared {
  const result = bundleFromSkillMd(bytes);
  return result.ok
    ? { ok: true, source: "skill_md", bundle: result.value }
    : { ok: false, error: result.error };
}

function bundleError(c: Ctx, err: BundleError) {
  const status = err.code === "bundle_too_large" ? 413 : 400;
  return error(c, status, err.code, err.message);
}
