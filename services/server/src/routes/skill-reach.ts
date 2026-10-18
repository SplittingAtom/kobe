import { Hono, type Context } from "hono";
import { z } from "zod";
import { withTeam } from "@kobe/db";
import { requireTeam, type TeamVariables } from "../authz/middleware.js";
import { teamRoleAllows } from "../authz/permissions.js";
import type { ServerDeps } from "../deps.js";
import { SKILL_ACCESS_MODES } from "@kobe/protocol";
import { setTeamSkillAccess } from "../skills/access.js";
import { MAX_OFFERED_SKILLS, agentNames, setOfferToAll, skillReach } from "../skills/reach.js";
import { findSkill, type SkillLocation, type SkillRecord } from "../skills/store.js";
import { skillUsageInTx } from "../skills/usage.js";
import { parseBody } from "../teams/http.js";

type Ctx = Context<{ Variables: TeamVariables }>;

const idSchema = z.uuid();
const offerSchema = z.strictObject({ offerToAll: z.boolean() });
const accessSchema = z.strictObject({ access: z.enum(SKILL_ACCESS_MODES) });

const OFFER_LIMIT = `A team can have at most ${MAX_OFFERED_SKILLS} skills On by default or Required. Change another skill first.`;

const notFound = (c: Ctx) => c.json({ code: "not_found", message: "No such skill." }, 404);

/**
 * A skill's reach and use (KOBE-297), next to `skills.ts` under `/v1/skills`:
 * - `GET /:id/reach` (team skills): the agents whose runs get it, named or by the offer, and which
 *   of the team's agents the caller may add it to.
 * - `PUT /:id/offer` (team admins): "Offer to all agents" on or off, audited (KOBE-297; the web
 *   uses `/access` since KOBE-316, this stays for older pages).
 * - `PUT /:id/access` (KOBE-316, SK25): the access mode. Builders set Available, On by default and
 *   Hidden; only Team admins make a skill Required or change a Required one. Audited; the answer
 *   carries the team's Required count and a warning from 5.
 * - `GET /:id/usage`: uses in this team (SKILL.md reads the server matched), the last one and the
 *   agents; for a team skill to its owner and team admins, for a personal one to its owner.
 */
export function skillReachRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));

  /** The skill, team first, then the caller's personal one (as `skills.ts` `visible`). */
  async function visible(c: Ctx): Promise<SkillRecord | null> {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) return null;
    const locations: SkillLocation[] = [
      { scope: "team", teamId: c.get("team").id },
      { scope: "personal", ownerUserId: c.get("user").id },
    ];
    for (const location of locations) {
      const skill = await findSkill(db, location, id.data);
      if (skill) return skill;
    }
    return null;
  }

  app.get("/:id/reach", async (c) => {
    const skill = await visible(c);
    if (!skill || skill.scope !== "team") return notFound(c);
    const viewer = { teamId: c.get("team").id, userId: c.get("user").id, role: c.get("team").role };
    const reach = await skillReach(db, viewer, skill.id);
    return reach ? c.json(reach) : notFound(c);
  });

  app.put("/:id/offer", async (c) => {
    if (!teamRoleAllows(c.get("team").role, "team.skills.review"))
      return c.json({ code: "forbidden", message: "Only team admins can change this." }, 403);
    const body = await parseBody(c, offerSchema);
    if (!body)
      return c.json({ code: "invalid_request", message: "Send offerToAll: true or false." }, 400);
    const skill = await visible(c);
    if (!skill || skill.scope !== "team") return notFound(c);
    const result = await setOfferToAll(db, c.get("team").id, skill.id, body.offerToAll);
    if (result.ok) return c.json({ offerToAll: result.offerToAll });
    if (result.error === "not_found") return notFound(c);
    if (result.error === "access_mode")
      return c.json(
        {
          code: "access_mode",
          message: "This skill is Required or Hidden: change it with its Access setting.",
        },
        409,
      );
    return c.json(
      {
        code: "offer_limit",
        message: `A team can offer at most ${MAX_OFFERED_SKILLS} skills to all agents. Turn the offer off for another skill first.`,
      },
      409,
    );
  });

  app.put("/:id/access", async (c) => {
    const role = c.get("team").role;
    if (!teamRoleAllows(role, "team.skills.publish"))
      return c.json(
        { code: "forbidden", message: "Only builders and team admins can change this." },
        403,
      );
    const body = await parseBody(c, accessSchema);
    if (!body)
      return c.json(
        {
          code: "invalid_request",
          message: "Send access: available, default_on, required or hidden.",
        },
        400,
      );
    const skill = await visible(c);
    if (!skill || skill.scope !== "team") return notFound(c);
    const result = await setTeamSkillAccess(db, {
      teamId: c.get("team").id,
      skillId: skill.id,
      access: body.access,
      mayRequire: teamRoleAllows(role, "team.skills.review"),
    });
    if (result.ok) {
      const { ok: _ok, ...answer } = result;
      return c.json(answer);
    }
    if (result.code === "not_found") return notFound(c);
    if (result.code === "forbidden")
      return c.json(
        { code: "forbidden", message: "Only team admins set or change Required." },
        403,
      );
    return c.json({ code: "offer_limit", message: OFFER_LIMIT }, 409);
  });

  app.get("/:id/usage", async (c) => {
    const skill = await visible(c);
    if (!skill) return notFound(c);
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const mayRead =
      skill.ownerUserId === userId || teamRoleAllows(c.get("team").role, "team.skills.review");
    if (skill.scope === "team" && !mayRead)
      return c.json(
        { code: "forbidden", message: "Usage is shown to the skill's owner and team admins." },
        403,
      );
    const body = await withTeam(db, teamId, async (tx) => {
      const usage = await skillUsageInTx(tx, teamId, {
        source: skill.scope,
        name: skill.slug,
        ownerUserId: userId,
      });
      const ids = usage.agents.flatMap((a) => (a.agentId === null ? [] : [a.agentId]));
      const names = await agentNames(tx, { teamId, userId }, ids);
      return {
        uses: usage.uses,
        lastUsedAt: usage.lastUsedAt?.toISOString() ?? null,
        // An agent the caller can't see (someone's personal agent) is counted without its name.
        agents: usage.agents.map((a) => {
          const known = a.agentId === null ? undefined : names.get(a.agentId);
          return {
            agentId: known ? a.agentId : null,
            scope: known?.scope ?? null,
            name: known?.name ?? null,
            uses: a.uses,
          };
        }),
      };
    });
    return c.json(body);
  });

  return app;
}
