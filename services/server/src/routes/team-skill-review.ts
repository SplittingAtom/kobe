import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { decideReview, listReviews, type ReviewRecord } from "../skills/review.js";
import { getPersonalSkillsDisabled, setPersonalSkillsDisabled } from "../skills/settings.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const STATUS_FILTERS = {
  pending: ["pending"],
  approved: ["approved"],
  rejected: ["rejected"],
  all: ["pending", "approved", "rejected"],
} as const;
const filterSchema = z.enum(["pending", "approved", "rejected", "all"]);
const decisionSchema = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(2000).optional(),
});
const settingsSchema = z.strictObject({ personalSkillsDisabled: z.boolean() });
const idSchema = z.uuid();
const versionSchema = z.coerce.number().int().positive().max(2147483647);

const reviewJson = (r: ReviewRecord) => ({
  skillId: r.skillId,
  slug: r.slug,
  version: r.version,
  contentHash: r.contentHash,
  status: r.status,
  flagged: r.flagged,
  findings: r.findings,
  scripts: r.scripts,
  skipped: r.skipped,
  scannedAt: r.scannedAt,
  reviewedBy: r.reviewedBy,
  reviewedAt: r.reviewedAt,
  reviewNote: r.reviewNote,
});

/**
 * Team skill review (`/v1/team/skill-review`, spec D22, KOBE-80). Team admins list the scanned
 * versions waiting for review (flagged first) and approve or reject them; only approved versions
 * are usable. The switch `personalSkillsDisabled` leaves members' personal skills out of the team's
 * runs. Both changes are audited.
 */
export function teamSkillReviewRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", requireTeamPermission("team.skills.review"), async (c) => {
    const filter = filterSchema.safeParse(c.req.query("status") ?? "pending");
    if (!filter.success)
      return invalidRequest(c, "status must be pending, approved, rejected or all.");
    const rows = await listReviews(db, c.get("team").id, STATUS_FILTERS[filter.data]);
    return c.json({ reviews: rows.map(reviewJson) });
  });

  app.post(
    "/:skillId/versions/:version",
    requireTeamPermission("team.skills.review"),
    async (c) => {
      const skillId = idSchema.safeParse(c.req.param("skillId"));
      const version = versionSchema.safeParse(c.req.param("version"));
      const body = await parseBody(c, decisionSchema);
      if (!skillId.success || !version.success) {
        return c.json({ code: "not_found", message: "No such skill version." }, 404);
      }
      if (!body)
        return invalidRequest(c, "Send decision: approved or rejected, and an optional note.");
      const result = await decideReview(
        db,
        c.get("team").id,
        { skillId: skillId.data, version: version.data },
        { status: body.decision, note: body.note || null, reviewerId: c.get("user").id },
      );
      if (!result.ok) {
        return result.error === "not_found"
          ? c.json({ code: "not_found", message: "No such skill version." }, 404)
          : c.json(
              { code: "unchanged", message: `That version is already ${body.decision}.` },
              409,
            );
      }
      return c.json({ review: reviewJson(result.review) });
    },
  );

  app.get("/settings", requireTeamPermission("team.read"), async (c) =>
    c.json({ personalSkillsDisabled: await getPersonalSkillsDisabled(db, c.get("team").id) }),
  );

  app.put("/settings", requireTeamPermission("team.skills.review"), async (c) => {
    const body = await parseBody(c, settingsSchema);
    if (!body) return invalidRequest(c, "Send personalSkillsDisabled: true or false.");
    const value = await setPersonalSkillsDisabled(
      db,
      c.get("team").id,
      c.get("user").id,
      body.personalSkillsDisabled,
    );
    return c.json({ personalSkillsDisabled: value });
  });

  return app;
}
