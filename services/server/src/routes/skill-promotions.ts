import { Hono, type Context } from "hono";
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
import { invalidRequest, parseBody } from "../teams/http.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const sourceSchema = z.strictObject({
  scope: z.enum(["team", "personal"]),
  skillId: z.uuid(),
  version: z.coerce.number().int().positive().max(2147483647),
});
const declineSchema = z.strictObject({ note: z.string().trim().min(1).max(1000).optional() });
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

function answer(c: Ctx, r: PromoteResult) {
  if (r.ok && r.kind === "submitted")
    return c.json({ state: "submitted", registryVersionId: r.registryVersionId }, 201);
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
  const status = { not_found: 404, forbidden: 403, legacy: 409, already_requested: 409 } as const;
  return c.json({ code: r.code, message: r.message }, status[r.code]);
}

function depsOf(deps: ServerDeps): PromoteDeps | null {
  const blobs = deps.blobs;
  if (!blobs) return null;
  return { db: deps.database.db, store: new PostgresSkillStore(deps.database.db, blobs), blobs };
}

const UNAVAILABLE = { code: "storage_unavailable", message: "Skill storage is not configured." };

/**
 * Promote to Site (`/v1/skills/promotions`, KOBE-333, SK19): a preview of what leaves the team
 * and the rule check, then the promotion (submitted, or a request waiting for a Team admin).
 */
export function skillPromotionRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
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

  app.post("/", requireTeamPermission("team.personal.create"), async (c) => {
    const p = depsOf(deps);
    if (!p) return c.json(UNAVAILABLE, 503);
    const body = await parseBody(c, sourceSchema);
    if (!body) return invalidRequest(c, "Send scope, skillId and version.");
    const team = c.get("team");
    return answer(
      c,
      await promote(p, { ...body, teamId: team.id }, { userId: c.get("user").id, role: team.role }),
    );
  });

  return app;
}

/**
 * The team's Promote to Site queue (`/v1/team/skill-promotions`, SK19): Team admins see each
 * Builder's request with exactly what would leave the team, and confirm or decline it.
 */
export function teamSkillPromotionRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
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
    return answer(c, await confirmRequest(p, c.get("team").id, id.data, c.get("user").id));
  });

  app.post("/:id/decline", async (c) => {
    const id = idSchema.safeParse(c.req.param("id"));
    const body = await parseBody(c, declineSchema);
    if (!id.success || !body)
      return invalidRequest(c, "Send an optional note (up to 1000 characters).");
    const ok = await declineRequest(
      deps.database.db,
      c.get("team").id,
      id.data,
      c.get("user").id,
      body.note ?? null,
    );
    if (!ok) return c.json({ code: "not_found", message: "No such open request." }, 404);
    return c.json({ state: "declined" });
  });

  return app;
}
