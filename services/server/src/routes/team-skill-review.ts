import { MODEL_ALIAS_PATTERN } from "@kobe/db";
import { teamEvalCapSchema } from "@kobe/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import { siteRoleAllows } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import {
  decideReview,
  decodeCursor,
  findingsDigest,
  reviewVerdict,
  listReviews,
  scanUnscanned,
  type ReviewRecord,
} from "../skills/review.js";
import {
  getCatalogSwitches,
  getEvalCap,
  getEvalJudgeAlias,
  getPersonalSkillsDisabled,
  setTeamSkillSettings,
} from "../skills/settings.js";
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
  /**
   * The `findingsDigest` of the scan the reviewer read and accepts (KOBE-312): needed to approve a
   * Caution or Block scan, and it must still match the stored findings.
   */
  acknowledgedFindings: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
const settingsSchema = z
  .strictObject({
    personalSkillsDisabled: z.boolean().optional(),
    membersMayAddCatalog: z.boolean().optional(),
    buildersMayInstallCatalog: z.boolean().optional(),
    /** The team's eval judge (KOBE-326): one of its enabled models, or null for the default. */
    evalJudgeAlias: z.string().regex(new RegExp(MODEL_ALIAS_PATTERN)).max(64).nullable().optional(),
    /** The monthly team eval cap (KOBE-327): `{usd}` or `{tokens}`, or null for none. */
    evalCap: teamEvalCapSchema.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined));
const idSchema = z.uuid();
const limitSchema = z.coerce.number().int().min(1).max(200);
const versionSchema = z.coerce.number().int().positive().max(2147483647);

const reviewJson = (r: ReviewRecord) => ({
  skillId: r.skillId,
  slug: r.slug,
  version: r.version,
  semver: r.semver,
  contentHash: r.contentHash,
  scope: r.scope,
  unscanned: r.unscanned,
  status: r.status,
  flagged: r.flagged,
  verdict: reviewVerdict(r),
  /** Echo it as `acknowledgedFindings` to approve exactly these findings. */
  findingsDigest: findingsDigest(r),
  findings: r.findings,
  scripts: r.scripts,
  skipped: r.skipped,
  scannedAt: r.scannedAt,
  blocked: r.blocked,
  /** A rescan on a scanner rule-set change turned the approved version Block (KOBE-313). */
  suspended: r.suspendedAt !== null,
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
    const limit = limitSchema.safeParse(c.req.query("limit") ?? 200);
    const cursorText = c.req.query("cursor");
    const cursor = cursorText === undefined ? undefined : decodeCursor(cursorText);
    if (!limit.success || (cursorText !== undefined && !cursor))
      return invalidRequest(c, "limit must be 1 to 200 and cursor one this API returned.");
    if (deps.blobs) await scanUnscanned(db, deps.blobs, c.get("team").id);
    const page = await listReviews(db, c.get("team").id, STATUS_FILTERS[filter.data], {
      limit: limit.data,
      ...(cursor ? { cursor } : {}),
    });
    return c.json({ reviews: page.reviews.map(reviewJson), nextCursor: page.nextCursor });
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
        {
          status: body.decision,
          note: body.note || null,
          reviewerId: c.get("user").id,
          ...(body.acknowledgedFindings ? { acknowledgedFindings: body.acknowledgedFindings } : {}),
          mayOverrideBlock: siteRoleAllows(c.get("siteRole"), "site.skills.override_scan"),
        },
      );
      if (!result.ok) {
        if (result.error === "not_found")
          return c.json({ code: "not_found", message: "No such skill version." }, 404);
        if (result.error === "acknowledgement_required")
          return c.json(
            {
              code: result.error,
              message: "The scan has findings: read them and acknowledge them to approve.",
            },
            422,
          );
        if (result.error === "findings_changed")
          return c.json(
            {
              code: result.error,
              message: "The scan's findings changed since you read them: review them again.",
            },
            409,
          );
        if (result.error === "scan_pending")
          return c.json(
            {
              code: result.error,
              message: "This version has not been scanned yet: it can be approved once it is.",
            },
            409,
          );
        if (result.error === "scan_blocked")
          return c.json(
            {
              code: result.error,
              message:
                "The scan blocks this version: only a Site admin can approve it, with a reason.",
            },
            409,
          );
        if (result.error === "override_reason_required")
          return invalidRequest(c, "Give a reason (note) to approve a version the scan blocks.");
        if (result.error === "blocklisted")
          return c.json(
            {
              code: "skill_blocklisted",
              message: "This bundle is on the site's blocklist and can't be approved.",
            },
            409,
          );
        return c.json(
          { code: "unchanged", message: `That version is already ${body.decision}.` },
          409,
        );
      }
      return c.json({ review: reviewJson(result.review) });
    },
  );

  // The team's skill switches: personal skills (KOBE-80) and the catalog switches (KOBE-316,
  // SK25: "Members may add catalog skills for themselves", "Builders may install catalog
  // skills"). Any member reads them; Team admins change them, each change audited.
  const settingsJson = async (teamId: string) => {
    const catalog = await getCatalogSwitches(db, teamId);
    return {
      personalSkillsDisabled: await getPersonalSkillsDisabled(db, teamId),
      membersMayAddCatalog: catalog.membersMayAdd,
      buildersMayInstallCatalog: catalog.buildersMayInstall,
      // Null: the team default judges (also when the chosen model was disabled since).
      evalJudgeAlias: await getEvalJudgeAlias(db, teamId),
      evalCap: await getEvalCap(db, teamId),
    };
  };

  app.get("/settings", requireTeamPermission("team.read"), async (c) =>
    c.json(await settingsJson(c.get("team").id)),
  );

  app.put("/settings", requireTeamPermission("team.skills.review"), async (c) => {
    const body = await parseBody(c, settingsSchema);
    if (!body)
      return invalidRequest(
        c,
        "Send one or more of personalSkillsDisabled, membersMayAddCatalog and buildersMayInstallCatalog (true or false) evalJudgeAlias (a model alias or null) and evalCap ({usd} or {tokens} per month, or null).",
      );
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    // One transaction (review L6); a judge model the team hasn't enabled changes nothing.
    const set = await setTeamSkillSettings(db, teamId, userId, {
      ...(body.personalSkillsDisabled !== undefined
        ? { personalSkillsDisabled: body.personalSkillsDisabled }
        : {}),
      catalog: {
        ...(body.membersMayAddCatalog !== undefined
          ? { membersMayAdd: body.membersMayAddCatalog }
          : {}),
        ...(body.buildersMayInstallCatalog !== undefined
          ? { buildersMayInstall: body.buildersMayInstallCatalog }
          : {}),
      },
      ...(body.evalJudgeAlias !== undefined ? { evalJudgeAlias: body.evalJudgeAlias } : {}),
      ...(body.evalCap !== undefined ? { evalCap: body.evalCap } : {}),
    });
    if (!set.ok)
      return c.json(
        {
          code: "model_not_enabled",
          message: "The eval judge must be one of the team's enabled models.",
        },
        422,
      );
    return c.json(await settingsJson(teamId));
  });

  return app;
}
