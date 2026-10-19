import { sql } from "@kobe/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import { siteRoleAllows } from "../authz/permissions.js";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { usageSnapshot, viewerTeamsOf } from "../skills/usage-snapshot.js";
import { siteSkillUsage, teamSkillUsage } from "../skills/usage-views.js";

const idSchema = z.uuid();

/** The windows are fixed (ac-4): any query parameter is refused rather than ignored. */
function hasQuery(c: Context): boolean {
  return new URL(c.req.url).search.length > 1;
}
const FIXED = {
  code: "invalid_request",
  message: "Usage covers the last 30 finished UTC days; it takes no parameters.",
};

/**
 * Site-wide usage of one catalog skill, per version, with Default opt-outs
 * (`GET /v1/skills/catalog/:skillId/usage`, KOBE-339, SK26): its active maintainers and Site
 * admins only. Numbers under the minimum-count rule (`usage-views.ts`); never a team name or id.
 */
export function skillUsageRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.get("/:skillId/usage", async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    const missing = { code: "not_found", message: "No such catalog skill." };
    if (!id.success) return c.json(missing, 404);
    if (hasQuery(c)) return c.json(FIXED, 400);
    const userId = c.get("user").id;
    // Only a skill with a published version has usage (review L4: 404 alike for the rest).
    const found = await db.execute<{ maintainer: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM registry_maintainers m JOIN users u ON u.id = m.user_id
                      WHERE m.skill_id = s.id AND m.user_id = ${userId}
                        AND u.deactivated_at IS NULL) AS maintainer
        FROM registry_skills s
       WHERE s.id = ${id.data}
         AND EXISTS (SELECT 1 FROM registry_versions v WHERE v.skill_id = s.id
                      AND v.state::text IN ('approved', 'deprecated', 'withdrawn', 'revoked'))`);
    const row = found.rows[0];
    if (!row) return c.json(missing, 404);
    if (!row.maintainer && !siteRoleAllows(c.get("siteRole"), "site.skills.catalog.manage"))
      return c.json(
        { code: "forbidden", message: "Only the skill's maintainers and Site admins see this." },
        403,
      );
    const versions = await db.execute<{ semver: string }>(sql`
      SELECT semver FROM registry_versions
       WHERE skill_id = ${id.data}
         AND state::text IN ('approved', 'deprecated', 'withdrawn', 'revoked')
       ORDER BY seq DESC`);
    const snapshot = await usageSnapshot(db);
    return c.json(
      siteSkillUsage(
        snapshot,
        id.data,
        versions.rows.map((v) => v.semver),
        await viewerTeamsOf(db, userId),
      ),
    );
  });
  return app;
}

/**
 * The team's own usage of catalog skills (`GET /v1/team/skills/usage`, KOBE-339, SK26), Team
 * admins: runs, members and thumbs per skill and version in the fixed window.
 */
export function teamSkillUsageRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.get("/usage", requireTeamPermission("team.skills.installs.manage"), async (c) => {
    if (hasQuery(c)) return c.json(FIXED, 400);
    const snapshot = await usageSnapshot(db);
    const rows = teamSkillUsage(snapshot, c.get("team").id, c.get("user").id);
    const names = new Map<string, string>();
    if (rows.length > 0) {
      const r = await db.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM registry_skills WHERE id IN (${sql.join(
          rows.map((x) => sql`${x.skillId}`),
          sql`, `,
        )})`);
      for (const x of r.rows) names.set(x.id, x.name);
    }
    return c.json({
      skills: rows
        .map((x) => ({ ...x, name: names.get(x.skillId) ?? "" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      window: { from: snapshot.from, to: snapshot.to },
      refreshedAt: snapshot.computedAt,
    });
  });
  return app;
}
