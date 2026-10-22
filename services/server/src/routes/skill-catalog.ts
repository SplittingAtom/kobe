import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { CATALOG_SORTS, browseCatalog, catalogDetail } from "../skills/catalog-browse.js";
import { invalidRequest } from "../teams/http.js";
import { exportCatalogVersion, type CatalogExportResult } from "../skills/catalog-export.js";
import { SKILL_EXPORT_RATE, exportResponse } from "../skills/export.js";
import { hitRateLimit } from "../rate-limit.js";
import {
  REQUESTS_PER_DAY,
  notifyTeamAdmins,
  requestForTeam,
} from "../skills/skill-install-requests.js";

const querySchema = z.object({
  q: z.string().max(200).optional(),
  tag: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/)
    .optional(),
  sort: z.enum(CATALOG_SORTS).optional(),
});
const idSchema = z.uuid();

/**
 * The Catalog tab (`/v1/skills/catalog`, KOBE-336, SK25): any member browses and searches the
 * catalog from the active team and opens a skill's detail with this team's egress check.
 */
export function skillCatalogRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/", requireTeamPermission("team.read"), async (c) => {
    const q = querySchema.safeParse(c.req.query());
    if (!q.success)
      return invalidRequest(c, "q (text), tag (a topic tag) and sort (name, updated, teams).");
    const who = { teamId: c.get("team").id, userId: c.get("user").id };
    return c.json(
      await browseCatalog(db, who, {
        q: q.data.q ?? "",
        tag: q.data.tag ?? null,
        sort: q.data.sort ?? "name",
      }),
    );
  });

  app.get("/:skillId", requireTeamPermission("team.read"), async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    const notFound = { code: "not_found", message: "No such catalog skill." };
    if (!id.success) return c.json(notFound, 404);
    const who = {
      teamId: c.get("team").id,
      userId: c.get("user").id,
      role: c.get("team").role,
      siteRole: c.get("siteRole"),
    };
    const detail = await catalogDetail(db, deps.blobs ?? null, who, id.data);
    return detail ? c.json(detail) : c.json(notFound, 404);
  });

  // A catalog version's portable export (KOBE-345): members of a team that hasn't blocked it.
  app.get("/:skillId/versions/:semver/export", requireTeamPermission("team.read"), async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    const semver = c.req.param("semver");
    const format = z.enum(["portable", "portable_evals"]).safeParse(c.req.query("format"));
    if (!format.success)
      return c.json(
        { code: "invalid_request", message: "Give format=portable or format=portable_evals." },
        400,
      );
    if (!id.success || !/^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$/.test(semver))
      return c.json({ code: "not_found", message: "No such catalog version." }, 404);
    if (!(await hitRateLimit(db, `skill-export:${c.get("user").id}`, SKILL_EXPORT_RATE)))
      return c.json(
        { code: "rate_limited", message: "Too many downloads. Wait a minute and try again." },
        429,
      );
    const r = await exportCatalogVersion(
      db,
      deps.blobs ?? null,
      { skillId: id.data, semver },
      format.data,
      c.get("team").id,
    );
    return r.ok ? exportResponse(r.exported) : catalogExportRefusal(c, r.code);
  });

  // Request for team (KOBE-338, SK25): asks this team's admins to install the skill.
  app.post("/:skillId/request", requireTeamPermission("team.read"), async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    if (!id.success) return c.json({ code: "not_found", message: "No such catalog skill." }, 404);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const r = await requestForTeam(db, { teamId, userId, skillId: id.data });
    if (!r.ok) {
      const errors = {
        not_found: [404, "No such catalog skill."],
        blocked: [409, "A Team admin blocked this skill in the team."],
        request_limit: [
          429,
          `You can ask for up to ${REQUESTS_PER_DAY} skills a day. Try again tomorrow.`,
        ],
      } as const;
      const [status, message] = errors[r.code];
      return c.json({ code: r.code, message }, status);
    }
    if (r.alreadyRequested) return c.json({ requested: true, alreadyRequested: true });
    deps.background.run("skill install request email failed", () =>
      notifyTeamAdmins(
        { db, mailer: deps.mailer, publicUrl: new URL(deps.publicUrl).origin },
        { teamId, userId, skill: r.name, installed: r.installed },
      ),
    );
    return c.json({ requested: true, alreadyRequested: false }, 202);
  });

  return app;
}

/** The answer for a refused catalog export. */
export function catalogExportRefusal(
  c: { json: (body: unknown, status: 404 | 409 | 413 | 422 | 503) => Response },
  code: Extract<CatalogExportResult, { ok: false }>["code"],
): Response {
  const answers = {
    not_found: [404, "No such catalog version (only published ones export)."],
    blocked: [422, "This version is blocked here or on the site's blocklist."],
    unavailable: [503, "This version's package is not available."],
    too_large: [413, "The export is larger than a skill may be."],
  } as const;
  const [status, message] = answers[code];
  return c.json({ code, message }, status);
}
