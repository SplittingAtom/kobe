import { Hono, type Context } from "hono";
import type { AuthVariables } from "../auth/session.js";
import type { ServerDeps } from "../deps.js";
import {
  addExistingMembers,
  searchCandidates,
  type AddMembersError,
} from "../teams/add-existing.js";
import { afterMemberRemoved, afterMemberRoleChanged } from "../teams/after-change.js";
import { invalidRequest, membershipError, parseBody } from "../teams/http.js";
import {
  SITE_ADMIN_VIA,
  findTeam,
  removeMember,
  setMemberRole,
  takeOverMember,
} from "../teams/members.js";
import { mailMembersAdded } from "../teams/notify-added.js";
import { notifyTeamAdmins } from "../teams/notify-admins.js";
import { addMembersSchema, idSchema, memberRoleSchema, teamRoleSchema } from "../teams/schemas.js";

type Ctx = Context<{ Variables: AuthVariables }>;

const ADD_ERRORS = {
  self_add_refused: [
    403,
    "You can't add yourself to a team here. Site admins reach team content through break-glass.",
  ],
  user_not_found: [404, "No Kobe user with that id."],
  user_deactivated: [409, "That account is deactivated. Reactivate it first."],
  user_unverified: [
    409,
    "That account's email address is not verified, so it can't be added. Invite the person instead.",
  ],
  already_member: [409, "That user is already a member of this team."],
} as const satisfies Record<AddMembersError, readonly [number, string]>;

const selfRefused = {
  code: "self_change_refused",
  message:
    "You can't change your own membership from the Site console. Ask a team admin of the team.",
} as const;

/**
 * A Site admin manages a team's members from the Site console (KOBE-638, mounted under
 * `/v1/site/teams/:teamId`, permission `site.teams.manage` from the parent): search existing users,
 * add them directly (no invitation), change team roles, remove, and Take over a provider-managed
 * row. Changes run through the Team console's code paths (`teams/members.ts`, `after-change.ts`),
 * so the same rules (last team admin, managed rows) and side effects apply; every change is audited
 * in the team's log with `via: "site_admin"`. The caller's own membership is never changed here.
 */
export function siteTeamMembersRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  const teamNotFound = { code: "team_not_found", message: "No team with that id." } as const;

  /** The team (404 answered) and, for member routes, the target user id (400 answered). */
  async function target(c: Ctx) {
    const teamId = idSchema.safeParse(c.req.param("teamId"));
    if (!teamId.success) return { response: invalidRequest(c) };
    const team = await findTeam(db, teamId.data);
    if (!team) return { response: c.json(teamNotFound, 404) };
    const raw = c.req.param("userId");
    if (raw === undefined) return { team };
    const userId = idSchema.safeParse(raw);
    if (!userId.success) return { response: invalidRequest(c) };
    if (userId.data === c.get("user").id) return { response: c.json(selfRefused, 403) };
    return { team, userId: userId.data };
  }

  app.get("/candidates", async (c) => {
    const t = await target(c);
    if (t.response) return t.response;
    const query = (c.req.query("q") ?? "").trim().slice(0, 200);
    const candidates = await searchCandidates(db, t.team.id, {
      query,
      actorId: c.get("user").id,
    });
    return c.json({ candidates });
  });

  app.post("/members", async (c) => {
    const t = await target(c);
    if (t.response) return t.response;
    const body = await parseBody(c, addMembersSchema);
    if (!body) return invalidRequest(c, "Pick up to 50 users and a team role.");
    const actor = c.get("user");
    const result = await addExistingMembers(db, t.team.id, { ...body, actorId: actor.id });
    if (!result.ok) {
      const [status, message] = ADD_ERRORS[result.error];
      return c.json({ code: result.error, message, userId: result.userId }, status);
    }
    mailMembersAdded(deps, {
      userIds: result.added,
      teamName: t.team.name,
      role: body.role,
      adderName: actor.name,
    });
    await notifyTeamAdmins(deps, {
      team: t.team,
      actor,
      change: "added",
      memberIds: result.added,
      role: body.role,
    });
    return c.json({ added: result.added.map((userId) => ({ userId, role: body.role })) }, 201);
  });

  app.patch("/members/:userId", async (c) => {
    const t = await target(c);
    if (t.response) return t.response;
    const body = await parseBody(c, memberRoleSchema);
    if (!body || !t.userId) return invalidRequest(c);
    const result = await setMemberRole(
      db,
      t.team.id,
      t.userId,
      body.role,
      body.expectedRole,
      SITE_ADMIN_VIA,
    );
    if (!result.ok) return membershipError(c, result.error);
    await afterMemberRoleChanged(deps, t.team.id, t.userId);
    await notifyTeamAdmins(deps, {
      team: t.team,
      actor: c.get("user"),
      change: "role_changed",
      memberIds: [t.userId],
      role: body.role,
    });
    return c.json({ userId: t.userId, role: body.role });
  });

  app.delete("/members/:userId", async (c) => {
    const t = await target(c);
    if (t.response) return t.response;
    const expectedRaw = c.req.query("expectedRole");
    const expected = expectedRaw === undefined ? undefined : teamRoleSchema.safeParse(expectedRaw);
    if (!t.userId || (expected !== undefined && !expected.success)) return invalidRequest(c);
    const result = await removeMember(db, t.team.id, t.userId, expected?.data, SITE_ADMIN_VIA);
    if (!result.ok) return membershipError(c, result.error);
    await afterMemberRemoved(deps, t.team.id, t.userId);
    await notifyTeamAdmins(deps, {
      team: t.team,
      actor: c.get("user"),
      change: "removed",
      memberIds: [t.userId],
      ...(expected?.data ? { role: expected.data } : {}),
    });
    return c.body(null, 204);
  });

  app.post("/members/:userId/take-over", async (c) => {
    const t = await target(c);
    if (t.response) return t.response;
    if (!t.userId) return invalidRequest(c);
    const result = await takeOverMember(db, t.team.id, t.userId, SITE_ADMIN_VIA);
    if (!result.ok) return membershipError(c, result.error);
    await notifyTeamAdmins(deps, {
      team: t.team,
      actor: c.get("user"),
      change: "taken_over",
      memberIds: [t.userId],
    });
    return c.json({ userId: t.userId, managedBy: null });
  });

  return app;
}
