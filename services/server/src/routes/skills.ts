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
import { isBlocked } from "../skills/blocklist.js";
import { reviewsOfSkill, scanCanonicalZip } from "../skills/review.js";
import { SCAN_RETRY_AFTER_SECONDS, ScanBusyError } from "../skills/scan-pool.js";
import type { ScanResult } from "@kobe/skill-scanner";
import { parseSemver } from "../skills/semver.js";
import { readUploadBody } from "../skills/upload-body.js";
import { IntegrityError } from "../skills/blob-read.js";
import { PostgresSkillStore, type SkillStore } from "../skills/skill-store.js";
import { logger } from "../logger.js";
import {
  findSkill,
  getSkillVersion,
  listSkills,
  listSkillVersions,
  type SkillLocation,
  type SkillRecord,
  type SkillScope,
  type SkillVersionRecord,
  type UploadError,
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

const UPLOAD_ERRORS: Record<
  Exclude<UploadError, "semver_not_increasing" | "semver_required"> | "blocklisted_download",
  string
> = {
  blocklisted_download: "This skill version is on the site's blocklist and can't be opened.",
  unchanged: "That bundle is identical to the current version.",
  skill_limit: "This location has reached its limit of skills.",
  version_limit: "This skill has reached its limit of versions.",
  blocklisted: "This skill bundle is on the site's blocklist and can't be uploaded.",
  name_clash:
    "The team has installed a catalog skill with this name. Uninstall it or choose another name.",
};

const skillJson = (s: SkillRecord) => ({
  id: s.id,
  scope: s.scope,
  slug: s.slug,
  description: s.description,
  latestVersion: s.latestVersion,
  latestSemver: s.latestSemver,
  access: s.access,
  archivedAt: s.archivedAt,
  ownerUserId: s.ownerUserId,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

/** Review state of a team version (personal versions have none: they are not reviewed). */
interface ReviewState {
  readonly status: string;
  readonly flagged: boolean;
}

const versionJson = (v: SkillVersionRecord, review: ReviewState | null = null) => ({
  version: v.version,
  seq: v.seq,
  semver: v.semver,
  changelog: v.changelog,
  packageHash: v.packageHash,
  frontmatter: v.frontmatter,
  source: v.source,
  contentHash: v.contentHash,
  sizeBytes: v.sizeBytes,
  fileCount: v.fileCount,
  uncompressedBytes: v.uncompressedBytes,
  uploadedBy: v.uploadedBy,
  uploadedAt: v.uploadedAt,
  review,
});

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
      let scan: ScanResult;
      try {
        scan = await scanCanonicalZip(bundle.packageZip ?? bundle.zip, { owner: c.get("user").id });
      } catch (err) {
        if (!(err instanceof ScanBusyError)) throw err;
        c.header("Retry-After", String(SCAN_RETRY_AFTER_SECONDS));
        return err.kind === "owner"
          ? error(
              c,
              429,
              "scan_busy",
              "Your earlier uploads are still being scanned. Try again shortly.",
            )
          : error(c, 503, "scan_busy", "Skill scanning is busy. Try again shortly.");
      }
      const location = locationFor(c, scope.data);
      const result = await store.putPackage(location, {
        bundle,
        source,
        uploadedBy: c.get("user").id,
        scan,
        ...requested.value,
      });
      if (!result.ok) {
        if (result.error === "semver_not_increasing")
          return error(
            c,
            409,
            result.error,
            `Version ${requested.value.semver ?? ""} must be higher than the latest version, ${result.latest}.`,
          );
        if (result.error === "semver_required")
          return error(
            c,
            400,
            result.error,
            `The next version after ${result.latest} can't be numbered automatically: give a semver (for example a new major).`,
          );
        return result.error === "blocklisted"
          ? error(c, 422, "skill_blocklisted", UPLOAD_ERRORS.blocklisted)
          : error(c, 409, result.error, UPLOAD_ERRORS[result.error]);
      }
      const review =
        scope.data === "team" ? { status: "pending", flagged: scan.findings.length > 0 } : null;
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
      return error(c, 422, "skill_blocklisted", UPLOAD_ERRORS.blocklisted_download);
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

/**
 * The number and changelog of an upload: from the request, or from the package's
 * `kobe.skill.yaml` (KOBE-309). When both give one, they must agree: the manifest never
 * renumbers a version behind the uploader's back.
 */
function numberingFrom(
  given: { readonly semver?: string | undefined; readonly changelog?: string | undefined },
  bundle: ValidBundle,
): { ok: true; value: { semver?: string; changelog?: string } } | { ok: false; message: string } {
  const manifest = bundle.manifest;
  if (manifest && given.semver !== undefined && given.semver !== manifest.version)
    return {
      ok: false,
      message: `semver ${given.semver} differs from kobe.skill.yaml's version ${manifest.version}.`,
    };
  if (
    manifest?.changelog &&
    given.changelog !== undefined &&
    given.changelog !== manifest.changelog
  )
    return { ok: false, message: "The changelog differs from kobe.skill.yaml's changelog." };
  const semver = given.semver ?? manifest?.version;
  const changelog = given.changelog ?? manifest?.changelog;
  return {
    ok: true,
    value: { ...(semver ? { semver } : {}), ...(changelog ? { changelog } : {}) },
  };
}

function bundleError(c: Ctx, err: BundleError) {
  const status = err.code === "bundle_too_large" ? 413 : 400;
  return error(c, status, err.code, err.message);
}
