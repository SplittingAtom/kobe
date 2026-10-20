import { putTeamSkillInstallSchema, uninstallSkillSchema } from "@kobe/protocol";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  installCatalogSkill,
  type SkillInstallResult,
  listTeamSkillInstalls,
  reinstallDefault,
  uninstallCatalogSkill,
} from "../skills/team-installs.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { skillInstallDiff, skillInstallUpdates } from "../skills/skill-install-updates.js";
import { semverSchema } from "../skills/semver.js";
import { teamRoleAllows } from "../authz/permissions.js";
import { REQUIRED_WARN_AT } from "../skills/access.js";

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
const SKILL_INSTALL_MISSING = {
  code: "not_found",
  message: "The team has no install of that skill.",
};

type Ctx = Context<{ Variables: TeamVariables }>;

/** The answer to an install, a Move pin or a Roll back. */
function skillInstallAnswer(c: Ctx, r: SkillInstallResult) {
  if (r.ok)
    return c.json({
      semver: r.semver,
      pinMode: r.pinMode,
      deprecated: r.deprecated,
      requiredCount: r.requiredCount,
      ...(r.requiredCount >= REQUIRED_WARN_AT ? { warning: "many_required" } : {}),
    });
  const errors = {
    not_found: [404, "No catalog skill with that id."],
    no_version: [404, "The skill has no version with that number."],
    not_installable: [
      409,
      "That version was withdrawn, revoked or suspended by a rescan, or is not approved.",
    ],
    blocked: [409, "The team blocked this skill: unblock it first."],
    forbidden: [
      403,
      "Builders can install catalog skills only while the team allows it, and never Required or deprecated versions.",
    ],
    name_clash: [
      409,
      "One of this team's own skills has the same name: rename or archive it first.",
    ],
  } as const;
  const [status, message] = errors[r.code];
  return c.json({ code: r.code, message }, status);
}

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
    c.json(await listTeamSkillInstalls(db, c.get("team").id)),
  );

  // Team admins, and Builders while "Builders may install catalog skills" is on (SK25); a Builder
  // never sets or changes Required and never installs a deprecated version.
  app.put("/installs/:skillId", requireTeamPermission("team.skills.publish"), async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    const body = await parseBody(c, putTeamSkillInstallSchema);
    if (!id.success || !body)
      return invalidRequest(c, "Send a version, a pin mode and an access mode.");
    const r = await installCatalogSkill(db, {
      teamId: c.get("team").id,
      skillId: id.data,
      userId: c.get("user").id,
      asBuilder: !teamRoleAllows(c.get("team").role, "team.skills.installs.manage"),
      ...body,
    });
    return skillInstallAnswer(c, r);
  });

  // Updates of an install (KOBE-337, SK25): what runs, newer versions with changelog and eval
  // delta, whether the pin takes them, and the Roll back target. Any member reads them.
  app.get("/installs/:skillId/updates", requireTeamPermission("team.read"), async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    if (!id.success) return c.json(SKILL_INSTALL_MISSING, 404);
    const u = await skillInstallUpdates(db, c.get("team").id, id.data);
    return u ? c.json(u) : c.json(SKILL_INSTALL_MISSING, 404);
  });

  // The file diff from the running version to another published one.
  app.get("/installs/:skillId/diff", requireTeamPermission("team.read"), async (c) => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    const to = semverSchema.safeParse(c.req.query("to"));
    if (!id.success || !to.success) return invalidRequest(c, "Send ?to=<version>.");
    if (!deps.blobs)
      return c.json(
        { code: "storage_unavailable", message: "Skill storage is not configured." },
        503,
      );
    const d = await skillInstallDiff(db, deps.blobs, c.get("team").id, id.data, to.data);
    return d
      ? c.json(d)
      : c.json({ code: "not_found", message: "No such install or version." }, 404);
  });

  // Move pin and Roll back (KOBE-337, SK25): single audited acts that keep the pin mode and
  // access; the same rules as an install (Builders, withdrawn and revoked versions, blocks).
  const moveTo = async (c: Ctx, version: string, act: "move" | "rollback") => {
    const id = idSchema.safeParse(c.req.param("skillId"));
    if (!id.success) return c.json(SKILL_INSTALL_MISSING, 404);
    // Pin mode and access are read under the install's lock inside (review-337 L4).
    const r = await installCatalogSkill(db, {
      teamId: c.get("team").id,
      skillId: id.data,
      userId: c.get("user").id,
      asBuilder: !teamRoleAllows(c.get("team").role, "team.skills.installs.manage"),
      version,
      act,
    });
    return skillInstallAnswer(c, r);
  };

  app.post("/installs/:skillId/move", requireTeamPermission("team.skills.publish"), async (c) => {
    const body = await parseBody(c, z.strictObject({ version: semverSchema }));
    if (!body) return invalidRequest(c, "Send the version to move the pin to.");
    return moveTo(c, body.version, "move");
  });

  app.post(
    "/installs/:skillId/rollback",
    requireTeamPermission("team.skills.publish"),
    async (c) => {
      const id = idSchema.safeParse(c.req.param("skillId"));
      if (!id.success) return c.json(SKILL_INSTALL_MISSING, 404);
      const u = await skillInstallUpdates(db, c.get("team").id, id.data);
      if (!u) return c.json(SKILL_INSTALL_MISSING, 404);
      if (!u.rollbackTo)
        return c.json(
          {
            code: "no_rollback",
            message: "This skill has no earlier version installed to go back to.",
          },
          409,
        );
      return moveTo(c, u.rollbackTo, "rollback");
    },
  );

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
      return r.ok ? c.json({ optedOut: r.optedOut }) : c.json(SKILL_INSTALL_MISSING, 404);
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
      const messages = {
        blocked: "The team blocked this skill: unblock it first.",
        name_clash: "One of this team's own skills has the same name: rename or archive it first.",
        no_version: "The default has no approved version right now.",
      } as const;
      return c.json({ code: r.code, message: messages[r.code] }, 409);
    },
  );

  return app;
}
