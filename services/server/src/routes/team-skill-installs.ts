import { putTeamSkillInstallSchema, uninstallSkillSchema } from "@kobe/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  installCatalogSkill,
  listTeamInstalls,
  reinstallDefault,
  uninstallCatalogSkill,
} from "../skills/team-installs.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const idSchema = z.uuid();

/** An optional JSON body: empty is `{}`, malformed is null (refused by the schema). */
function parseOptionalJson(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
const NOT_INSTALLED = { code: "not_found", message: "The team has no install of that skill." };

/**
 * A team's catalog installs (`/v1/team/skills`, KOBE-314, SK6, SK7): any member reads them and the
 * Removed defaults; Team admins uninstall (a Default skill records a sticky opt-out) and reinstall
 * removed defaults. Audited.
 */
export function teamSkillInstallRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/installs", requireTeamPermission("team.read"), async (c) =>
    c.json(await listTeamInstalls(db, c.get("team").id)),
  );

  app.put("/installs/:skillId", requireTeamPermission("team.skills.installs.manage"), async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    const body = await parseBody(c, putTeamSkillInstallSchema);
    if (!id.success || !body)
      return invalidRequest(c, "Send a version, a pin mode and an access mode.");
    const r = await installCatalogSkill(db, {
      teamId: c.get("team").id,
      skillId: id.data,
      userId: c.get("user").id,
      ...body,
    });
    if (r.ok) return c.json({ semver: r.semver, deprecated: r.deprecated });
    const errors = {
      not_found: [404, "No catalog skill with that id."],
      no_version: [404, "The skill has no version with that number."],
      not_installable: [409, "That version was withdrawn or revoked, or is not approved."],
      name_clash: [
        409,
        "One of this team's own skills has the same name: rename or archive it first.",
      ],
    } as const;
    const [status, message] = errors[r.code];
    return c.json({ code: r.code, message }, status);
  });

  app.delete(
    "/installs/:skillId",
    requireTeamPermission("team.skills.installs.manage"),
    async (c) => {
      const id = idSchema.safeParse(c.req.param("skillId"));
      const text = await c.req.text().catch(() => "");
      const body = uninstallSkillSchema.safeParse(parseOptionalJson(text));
      if (!id.success || !body.success)
        return invalidRequest(c, "Send an optional reason of up to 500 characters.");
      const r = await uninstallCatalogSkill(db, {
        teamId: c.get("team").id,
        skillId: id.data,
        userId: c.get("user").id,
        ...(body.data.reason ? { reason: body.data.reason } : {}),
      });
      return r.ok ? c.json({ optedOut: r.optedOut }) : c.json(NOT_INSTALLED, 404);
    },
  );

  app.post(
    "/removed-defaults/:skillId/reinstall",
    requireTeamPermission("team.skills.installs.manage"),
    async (c) => {
      const id = idSchema.safeParse(c.req.param("skillId"));
      if (!id.success) return invalidRequest(c, "Unknown skill id.");
      const r = await reinstallDefault(db, {
        teamId: c.get("team").id,
        skillId: id.data,
        userId: c.get("user").id,
      });
      if (r.ok) return c.json({ semver: r.semver }, 201);
      if (r.code === "not_found")
        return c.json(
          { code: "not_found", message: "That skill is not a removed default here." },
          404,
        );
      return r.code === "blocked"
        ? c.json(
            { code: "blocked", message: "The team blocked this skill: unblock it first." },
            409,
          )
        : c.json(
            { code: "no_version", message: "The default has no approved version right now." },
            409,
          );
    },
  );

  return app;
}
