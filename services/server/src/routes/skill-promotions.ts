import { Hono, type Context } from "hono";
import type { KobeDb } from "@kobe/db";
import { markNoRunner } from "../skills/registry/external-scan.js";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { preparePromotion, type PromotionPlan } from "../skills/registry/promote-check.js";
import {
  confirmRequest,
  declineRequest,
  pendingRequests,
  promote,
  requestPreview,
  type PromoteDeps,
  type PromoteResult,
} from "../skills/registry/promote.js";
import { PostgresSkillStore } from "../skills/skill-store.js";
import { hitRateLimit } from "../rate-limit.js";
import {
  createManifestDraft,
  type ManifestDraftResult,
} from "../skills/registry/promote-manifest.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { draftJson } from "./skill-drafts.js";
import { LICENSE_PATTERN } from "@kobe/protocol";

type Ctx = Context<{ Variables: TeamVariables }>;

const sourceSchema = z.strictObject({
  scope: z.enum(["team", "personal"]),
  skillId: z.uuid(),
  version: z.coerce.number().int().positive().max(2147483647),
});
const declineSchema = z.strictObject({ note: z.string().trim().min(1).max(1000).optional() });
/** Create kobe.skill.yaml (KOBE-564): the version, the member's model and their license choice. */
const manifestSchema = sourceSchema.extend({
  model: z.string().min(1).max(128).optional(),
  license: z.string().regex(LICENSE_PATTERN).optional(),
});
/** Manifest calls per user: each is one model call on their budget; over it: 429. */
export const MANIFEST_RATE = { windowMs: 10 * 60_000, max: 20 } as const;
const idSchema = z.uuid();

/** What leaves the team, for the Workbench dialog and the Team admin's confirmation (SK19). */
const planJson = (plan: PromotionPlan) => ({
  name: plan.name,
  semver: plan.semver,
  packageHash: plan.bundle.packageHash,
  files: plan.files,
  fixtures: plan.fixtures,
  fromConversation: plan.fromConversation,
  newSkill: plan.catalogSkillId === null,
  scorecard: plan.scorecard,
  verdict: plan.scan.verdict,
  refusals: plan.refusals,
});

/** Starts the optional external scan of a new submission (KOBE-341); a no-op when it is off. */
export interface ExternalScanStarter {
  start(registryVersionId: string): void;
}

async function answer(
  c: Ctx,
  r: PromoteResult,
  scans: ExternalScanStarter | undefined,
  db: KobeDb,
) {
  if (r.ok && r.kind === "submitted") {
    // The scan is queued with the submission when the Site has it on (review-341 M1); a server
    // without a runner says so on the version instead of leaving it queued.
    if (scans) scans.start(r.registryVersionId);
    else await markNoRunner(db, r.registryVersionId);
    return c.json({ state: "submitted", registryVersionId: r.registryVersionId }, 201);
  }
  if (r.ok) return c.json({ state: "requested", requestId: r.requestId }, 202);
  if (r.code === "refused")
    return c.json(
      {
        code: "submission_refused",
        message: "The version doesn't meet the Site's rules.",
        refusals: r.refusals,
      },
      422,
    );
  const status = {
    not_found: 404,
    forbidden: 403,
    legacy: 409,
    already_requested: 409,
    request_closed: 409,
  } as const;
  return c.json({ code: r.code, message: r.message }, status[r.code]);
}

function depsOf(deps: ServerDeps): PromoteDeps | null {
  const blobs = deps.blobs;
  if (!blobs) return null;
  return { db: deps.database.db, store: new PostgresSkillStore(deps.database.db, blobs), blobs };
}

const UNAVAILABLE = { code: "storage_unavailable", message: "Skill storage is not configured." };
const NO_MODEL_CALLS = {
  code: "model_calls_unavailable",
  message: "This server has no model gateway for its own calls; write kobe.skill.yaml yourself.",
};

/** The status of a refused manifest draft (KOBE-564): what went wrong, never a crash. */
const MANIFEST_STATUS: Record<Extract<ManifestDraftResult, { ok: false }>["code"], number> = {
  not_found: 404,
  forbidden: 403,
  has_manifest: 409,
  rate_limited: 429,
  busy: 409,
  blocklisted: 422,
  unavailable: 409,
  invalid_skill_md: 422,
  name_mismatch: 422,
  model_not_enabled: 422,
  no_model: 422,
  too_large: 413,
  call_failed: 502,
  not_serialisable: 502,
  stale_revision: 409,
  invalid_path: 400,
  name_taken: 409,
  not_sync_target: 409,
  too_many_files: 422,
  draft_limit: 422,
  draft_too_large: 413,
  file_too_large: 413,
};

/**
 * Promote to Site (`/v1/skills/promotions`, KOBE-333, SK19): a preview of what leaves the team
 * and the rule check, then the promotion (submitted, or a request waiting for a Team admin).
 */
export function skillPromotionRoutes(
  deps: ServerDeps,
  scans?: ExternalScanStarter,
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));

  app.get("/preview", requireTeamPermission("team.personal.create"), async (c) => {
    const p = depsOf(deps);
    if (!p) return c.json(UNAVAILABLE, 503);
    const source = sourceSchema.safeParse(c.req.query());
    if (!source.success) return invalidRequest(c, "Send scope, skillId and version.");
    const r = await preparePromotion(
      p.db,
      p.store,
      { ...source.data, teamId: c.get("team").id },
      c.get("user").id,
    );
    if (!r.ok) return c.json({ code: r.code, message: r.message }, r.code === "legacy" ? 409 : 404);
    return c.json(planJson(r.plan));
  });

  /**
   * Create kobe.skill.yaml for a version without one (KOBE-564): the member's chosen model
   * drafts it, and the version is forked into a Workbench draft of theirs holding the file.
   */
  app.post("/manifest", requireTeamPermission("team.personal.create"), async (c) => {
    const p = depsOf(deps);
    if (!p) return c.json(UNAVAILABLE, 503);
    if (!deps.skillManifests) return c.json(NO_MODEL_CALLS, 503);
    const body = await parseBody(c, manifestSchema);
    if (!body)
      return invalidRequest(c, "Send scope, skillId, version and, optionally, model and license.");
    const user = c.get("user");
    const team = c.get("team");
    const { model, license, ...source } = body;
    const r = await createManifestDraft(
      { ...p, generator: deps.skillManifests },
      { ...source, teamId: team.id },
      { userId: user.id, role: team.role },
      {
        model,
        license,
        // Counted only once the version is found and lacks a manifest (review L3).
        admit: () => hitRateLimit(deps.database.db, `skill-manifest:${user.id}`, MANIFEST_RATE),
      },
    );
    if (!r.ok)
      return c.json(
        { code: r.code, message: r.message, ...(r.detail ? { detail: r.detail } : {}) },
        MANIFEST_STATUS[r.code] as 400,
      );
    return c.json(
      {
        draft: draftJson(r.draft, user.id),
        manifest: r.manifest,
        model: r.model.alias,
        source: r.source,
      },
      201,
    );
  });

  app.post("/", requireTeamPermission("team.personal.create"), async (c) => {
    const p = depsOf(deps);
    if (!p) return c.json(UNAVAILABLE, 503);
    const body = await parseBody(c, sourceSchema);
    if (!body) return invalidRequest(c, "Send scope, skillId and version.");
    const team = c.get("team");
    return answer(
      c,
      await promote(p, { ...body, teamId: team.id }, { userId: c.get("user").id, role: team.role }),
      scans,
      deps.database.db,
    );
  });

  return app;
}

/**
 * The team's Promote to Site queue (`/v1/team/skill-promotions`, SK19): Team admins see each
 * Builder's request with exactly what would leave the team, and confirm or decline it.
 */
export function teamSkillPromotionRoutes(
  deps: ServerDeps,
  scans?: ExternalScanStarter,
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.skills.review"));

  app.get("/", async (c) =>
    c.json({ requests: await pendingRequests(deps.database.db, c.get("team").id) }),
  );

  app.get("/:id", async (c) => {
    const p = depsOf(deps);
    if (!p) return c.json(UNAVAILABLE, 503);
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ code: "not_found", message: "No such request." }, 404);
    const preview = await requestPreview(p, c.get("team").id, id.data);
    if (!preview) return c.json({ code: "not_found", message: "No such open request." }, 404);
    if (!preview.prepared.ok)
      return c.json({
        request: preview.request,
        code: preview.prepared.code,
        message: preview.prepared.message,
      });
    return c.json({ request: preview.request, ...planJson(preview.prepared.plan) });
  });

  app.post("/:id/confirm", async (c) => {
    const p = depsOf(deps);
    if (!p) return c.json(UNAVAILABLE, 503);
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ code: "not_found", message: "No such request." }, 404);
    return answer(
      c,
      await confirmRequest(p, c.get("team").id, id.data, c.get("user").id),
      scans,
      deps.database.db,
    );
  });

  app.post("/:id/decline", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const body = await parseBody(c, declineSchema);
    if (!id.success || !body)
      return invalidRequest(c, "Send an optional note (up to 1000 characters).");
    const r = await declineRequest(
      deps.database.db,
      c.get("team").id,
      id.data,
      c.get("user").id,
      body.note ?? null,
    );
    if (r === "not_found") return c.json({ code: "not_found", message: "No such request." }, 404);
    if (r === "closed")
      return c.json(
        { code: "request_closed", message: "Another Team admin already decided this request." },
        409,
      );
    return c.json({ state: "declined" });
  });

  return app;
}
