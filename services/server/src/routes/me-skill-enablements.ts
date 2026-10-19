import { Hono } from "hono";
import { z } from "zod";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { putMemberSkillAddSchema } from "@kobe/protocol";
import { listSkillChoices, setEnablement } from "../skills/enablements.js";
import { addForMe, listMyAdds, removeMyAdd, type AddRefusal } from "../skills/member-adds.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const enablementSchema = z.strictObject({
  kind: z.enum(["personal", "team", "catalog"]),
  skillId: z.uuid(),
  enabled: z.boolean(),
});

/**
 * A member's own skill choices in the active team (`/v1/me/skills`, KOBE-316, SK25, SK27, D22):
 * `GET /enablements` lists their personal skills (on or off here), the team's skills and installs
 * with their access and whether they load for this member; `PUT /enablements` turns one on or off
 * for this member only, audited. Required and Hidden skills are not the member's to toggle (409).
 */
export function meSkillEnablementRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  app.get("/enablements", requireTeamPermission("team.read"), async (c) =>
    c.json(await listSkillChoices(db, c.get("team").id, c.get("user").id)),
  );

  app.put("/enablements", requireTeamPermission("team.read"), async (c) => {
    const body = await parseBody(c, enablementSchema);
    if (!body) return invalidRequest(c, "Send kind, skillId and enabled: true or false.");
    const r = await setEnablement(db, {
      teamId: c.get("team").id,
      userId: c.get("user").id,
      ...body,
    });
    if (r.ok) return c.json({ enabled: r.enabled });
    return r.code === "not_found"
      ? c.json({ code: "not_found", message: "No such skill for you in this team." }, 404)
      : c.json(
          {
            code: "not_toggleable",
            message: "Required and Hidden skills are set by the team, not by each member.",
          },
          409,
        );
  });

  // Add for me (KOBE-338, SK25): a catalog skill in this member's runs in this team only.
  app.get("/adds", requireTeamPermission("team.read"), async (c) =>
    c.json({ adds: await listMyAdds(db, c.get("team").id, c.get("user").id) }),
  );

  app.put("/adds/:skillId", requireTeamPermission("team.read"), async (c) => {
    const id = z.uuid().safeParse(c.req.param("skillId"));
    if (!id.success) return c.json(ADD_ERRORS.not_found.body, 404);
    const body = await parseBody(c, putMemberSkillAddSchema);
    if (!body) return invalidRequest(c, "Send a version (x.y.z) and a pin mode.");
    const r = await addForMe(db, {
      teamId: c.get("team").id,
      userId: c.get("user").id,
      skillId: id.data,
      ...body,
    });
    if (r.ok) return c.json({ semver: r.semver, pinMode: r.pinMode, runs: r.runs });
    const e = ADD_ERRORS[r.code];
    return c.json(e.body, e.status);
  });

  app.delete("/adds/:skillId", requireTeamPermission("team.read"), async (c) => {
    const id = z.uuid().safeParse(c.req.param("skillId"));
    const done =
      id.success &&
      (await removeMyAdd(db, {
        teamId: c.get("team").id,
        userId: c.get("user").id,
        skillId: id.data,
      }));
    return done
      ? c.json({ removed: true })
      : c.json({ code: "not_found", message: "You haven't added that skill here." }, 404);
  });

  return app;
}

const refusal = <S extends 403 | 404 | 409>(code: AddRefusal, status: S, message: string) => ({
  status,
  body: { code, message },
});

/** Why an Add for me was refused. */
const ADD_ERRORS = {
  not_found: refusal("not_found", 404, "No catalog skill with that id."),
  no_version: refusal("no_version", 404, "The skill has no version with that number."),
  not_installable: refusal(
    "not_installable",
    409,
    "That version was withdrawn, revoked or suspended, or is not approved.",
  ),
  deprecated: refusal(
    "deprecated",
    409,
    "That version is deprecated: choose a current one, or ask a Team admin.",
  ),
  blocked: refusal("blocked", 409, "A Team admin blocked this skill in the team."),
  adds_off: refusal("adds_off", 403, "This team doesn't let members add catalog skills."),
  installed: refusal(
    "installed",
    409,
    "The team has this skill installed: its install governs. Use Request for team to ask for another version.",
  ),
  name_clash: refusal("name_clash", 409, "One of this team's own skills has the same name."),
} as const satisfies Record<AddRefusal, unknown>;
