import { RULE_SET, RULE_SET_VERSION } from "@kobe/skill-scanner";
import { desc, skillRescanRuns } from "@kobe/db";
import { Hono } from "hono";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";

const SHOWN = 20;

/**
 * Skill rescans on scanner rule-set changes (`/v1/site/skill-rescans`, KOBE-313, SK32): the
 * newest rescans with their progress, counts and the versions they suspended (ids and slugs, never
 * findings), and the rule set this server scans with. Site Owner/Admins, beside the blocklist.
 */
export function siteSkillRescanRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use(requireSitePermission("site.blocklist.manage"));
  app.get("/", async (c) => {
    const rows = await deps.database.db
      .select()
      .from(skillRescanRuns)
      .orderBy(desc(skillRescanRuns.ruleSet))
      .limit(SHOWN);
    return c.json({
      current: RULE_SET_VERSION,
      currentRuleSet: RULE_SET,
      rescans: rows.map((r) => ({
        ruleSet: r.ruleSet,
        ruleSetVersion: r.ruleSetVersion,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        scanned: r.scanned,
        changed: r.changed,
        suspended: r.suspended,
        failed: r.failed,
        suspensions: r.suspensions,
      })),
    });
  });
  return app;
}
