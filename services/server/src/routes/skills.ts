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
import {
  discardAttemptBundle,
  putSkillBundle,
  sha256Hex,
  skillBundleKey,
} from "../skills/storage.js";
import {
  findSkill,
  getSkillVersion,
  listSkills,
  listSkillVersions,
  uploadSkillVersion,
  type SkillLocation,
  type SkillRecord,
  type SkillScope,
  type SkillVersionRecord,
  type UploadError,
} from "../skills/store.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const ZIP_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
]);
const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown", "text/plain"]);
const scopeSchema = z.enum(["team", "personal"]);
const idSchema = z.uuid();
const versionSchema = z.coerce.number().int().positive();

const error = (
  c: Ctx,
  status: 400 | 403 | 404 | 409 | 413 | 415 | 503,
  code: string,
  message: string,
) => c.json({ code, message }, status);

const UPLOAD_ERRORS: Record<UploadError, string> = {
  unchanged: "That bundle is identical to the current version.",
  skill_limit: "This location has reached its limit of skills.",
  version_limit: "This skill has reached its limit of versions.",
};

const skillJson = (s: SkillRecord) => ({
  id: s.id,
  scope: s.scope,
  slug: s.slug,
  description: s.description,
  latestVersion: s.latestVersion,
  ownerUserId: s.ownerUserId,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

const versionJson = (v: SkillVersionRecord) => ({
  version: v.version,
  frontmatter: v.frontmatter,
  source: v.source,
  contentHash: v.contentHash,
  sizeBytes: v.sizeBytes,
  fileCount: v.fileCount,
  uncompressedBytes: v.uncompressedBytes,
  uploadedBy: v.uploadedBy,
  uploadedAt: v.uploadedAt,
});

/**
 * Skill bundles (spec D19, §6.1, KOBE-78) from the active team's point of view: the team's skills
 * and the caller's personal ones. `POST /?scope=team|personal` takes a zip (or a bare SKILL.md as
 * text/markdown) and stores it as the next immutable version of the skill its frontmatter names;
 * `GET /`, `GET /:id`, `GET /:id/versions[/:n]` read them. Scanning and review are KOBE-80.
 */
export function skillRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
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
      if (!deps.blobs)
        return error(c, 503, "skills_unavailable", "Skill storage is not configured.");
      if (!(await hitRateLimit(db, `skill-upload:${c.get("user").id}`, SKILL_UPLOAD_RATE)))
        return c.json(
          { code: "rate_limited", message: "Too many uploads. Wait a few minutes and try again." },
          429,
        );
      const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const prepared = ZIP_TYPES.has(type)
        ? prepareZip(bytes)
        : MARKDOWN_TYPES.has(type)
          ? prepareMarkdown(bytes)
          : null;
      if (!prepared)
        return error(c, 415, "unsupported_media_type", "Send application/zip or text/markdown.");
      if (!prepared.ok) return bundleError(c, prepared.error);
      const { bundle, source } = prepared;
      const zip = bundle.zip;

      const location = locationFor(c, scope.data);
      const contentHash = sha256Hex(zip);
      const storageKey = skillBundleKey(deps.blobs.prefix, location, contentHash);
      await putSkillBundle(deps.blobs, storageKey, zip);
      const blobs = deps.blobs;
      const discard = () => discardAttemptBundle(blobs, storageKey);
      const result = await uploadSkillVersion(db, location, {
        slug: bundle.name,
        description: bundle.description,
        frontmatter: bundle.frontmatter,
        source,
        contentHash,
        storageKey,
        sizeBytes: zip.length,
        fileCount: bundle.fileCount,
        uncompressedBytes: bundle.uncompressedBytes,
        uploadedBy: c.get("user").id,
      }).catch(async (err: unknown) => {
        await discard();
        throw err;
      });
      if (!result.ok) {
        await discard();
        return error(c, 409, result.error, UPLOAD_ERRORS[result.error]);
      }
      return c.json({ skill: skillJson(result.skill), version: versionJson(result.version) }, 201);
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
    const versions = await listSkillVersions(db, found.location, found.skill.id);
    return c.json({ versions: versions.map(versionJson) });
  });

  app.get("/:id/versions/:version", async (c) => {
    const found = await visible(c);
    const n = versionSchema.safeParse(c.req.param("version"));
    if (!found || !n.success) return error(c, 404, "not_found", "No such skill version.");
    const version = await getSkillVersion(db, found.location, found.skill.id, n.data);
    if (!version) return error(c, 404, "not_found", "No such skill version.");
    return c.json({ skill: skillJson(found.skill), version: versionJson(version) });
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
