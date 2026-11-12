import { z } from "zod";
import { cursorSchema, kobeTool, page, type KobeRouteCaller } from "../../catalog.js";
import { ROLE_LABEL, role } from "../team-members.js";
import { clip, missing, readAs } from "./shared.js";

/**
 * Site console › Teams › a team's members (KOBE-638, `/v1/site/teams/:teamId/members`, page
 * permission `site.teams.manage`): list, add existing users without an invitation, change a team
 * role, remove. The routes refuse adding or changing the caller themselves, a provider-managed row
 * (Take over stays console-only) and the last team admin; writes carry the approved before-state.
 */

const rosterRow = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role,
  addedVia: z.enum(["skill_reviewer_grant", "idp", "site_admin"]).nullable().optional(),
  managedBy: z.object({ providerName: z.string() }).nullable().optional(),
  deactivated: z.boolean().optional(),
});
const rosterAnswer = z.object({ members: z.array(rosterRow) });
const roster = (teamId: string) =>
  ({ method: "GET", path: `/site/teams/${teamId}/members` }) as const;

const memberOut = z.strictObject({
  user_id: z.uuid(),
  name: z.string().max(200),
  email: z.string().max(320),
  role,
  joined_by: z.enum(["invitation", "site_admin", "identity_provider", "skill_reviewer_grant"]),
  managed_by: z.string().max(200).optional(),
  deactivated: z.boolean(),
});

const joinedBy = (r: z.infer<typeof rosterRow>) =>
  r.addedVia === "idp"
    ? ("identity_provider" as const)
    : r.addedVia === "site_admin" || r.addedVia === "skill_reviewer_grant"
      ? r.addedVia
      : ("invitation" as const);

export const siteTeamMembersList = kobeTool({
  name: "site_team_members_list",
  title: "List a team's members",
  description:
    "Lists the members of one team with their team role, how they joined (invitation, site " +
    "admin, identity provider, Skill reviewer grant) and whether the account is deactivated " +
    "(Site console › Teams › Manage members; metadata only, never team content). Give the " +
    "team_id from site_teams_list. Paged: pass next_cursor back as cursor.",
  scope: "site",
  permission: "site.teams.manage",
  readOnly: true,
  input: z.strictObject({ team_id: z.uuid(), cursor: cursorSchema.optional() }),
  output: z.strictObject({
    members: z.array(memberOut).max(50),
    total: z.number().int(),
    next_cursor: cursorSchema.optional(),
  }),
  route: (input) => roster(input.team_id),
  reduce: (body, input) => {
    const all = rosterAnswer.parse(body).members;
    const { rows, next_cursor } = page(all, input.cursor);
    return {
      members: rows.map((m) => ({
        user_id: m.userId,
        name: clip(m.name, 200),
        email: clip(m.email, 320),
        role: m.role,
        joined_by: joinedBy(m),
        ...(m.managedBy ? { managed_by: clip(m.managedBy.providerName, 200) } : {}),
        deactivated: m.deactivated === true,
      })),
      total: all.length,
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

/** The member's role as the person reads it; undefined when not a member. */
async function currentRole(call: KobeRouteCaller, teamId: string, userId: string) {
  const answer = await readAs(call, roster(teamId), rosterAnswer);
  if (answer === undefined) return "unreadable" as const;
  return answer.members.find((m) => m.userId === userId)?.role;
}

const notMember = () => missing("not_a_member", "That user is not a member of this team.");

export const siteTeamMembersAdd = kobeTool({
  name: "site_team_members_add",
  title: "Add users to a team",
  description:
    "Adds existing, active Kobe users to a team at once, without an invitation (Site console › " +
    "Teams › Manage members); they are told in Kobe and by email. Give the team_id (from " +
    "site_teams_list), up to 50 user_ids (from site_users_list) and one team role for all of " +
    "them. All or nothing: refused when any user is deactivated, already a member, or yourself " +
    "(site admins reach team content only through break-glass). The person is always asked to " +
    "approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.teams.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({
    team_id: z.uuid(),
    user_ids: z.array(z.uuid()).min(1).max(50),
    role,
  }),
  output: z.strictObject({ team_id: z.uuid(), added: z.array(z.uuid()).max(50), role }),
  route: (input) => ({
    method: "POST",
    path: `/site/teams/${input.team_id}/members`,
    body: { userIds: input.user_ids, role: input.role },
  }),
  reduce: (body, input) => {
    const { added } = z.object({ added: z.array(z.object({ userId: z.uuid() })) }).parse(body);
    return { team_id: input.team_id, added: added.map((a) => a.userId), role: input.role };
  },
  // The before-state of an Add is "none of them is a member"; the route's insert decides a race.
  before: async (input, call) => {
    const answer = await readAs(call, roster(input.team_id), rosterAnswer);
    if (answer === undefined) return missing("team_not_found", "No team with that id.");
    const present = new Set(answer.members.map((m) => m.userId));
    return input.user_ids.some((u) => present.has(u))
      ? missing("already_member", "One of those users is already a member of this team.")
      : "same";
  },
  summary: (input) =>
    `Add ${input.user_ids.length === 1 ? `user ${input.user_ids[0]}` : `${input.user_ids.length} users`} to team ${input.team_id} as ${ROLE_LABEL[input.role]}, without an invitation`,
});

export const siteTeamMembersSetRole = kobeTool({
  name: "site_team_members_set_role",
  title: "Change a team member's role",
  description:
    "Changes a member's team role in any team (Site console › Teams › Manage members). Give the " +
    "team_id, the member's user_id, the role they have now (from site_team_members_list) and the " +
    "new role. A team always keeps one active team admin; rows an identity provider manages and " +
    "your own membership can't be changed here. The person is always asked to approve; never " +
    "retry a refused or denied call.",
  scope: "site",
  permission: "site.teams.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ team_id: z.uuid(), user_id: z.uuid(), from_role: role, to_role: role }),
  output: z.strictObject({ team_id: z.uuid(), user_id: z.uuid(), role }),
  route: (input) => ({
    method: "PATCH",
    path: `/site/teams/${input.team_id}/members/${input.user_id}`,
    body: { role: input.to_role, expectedRole: input.from_role },
  }),
  reduce: (body, input) => {
    const parsed = z.object({ userId: z.uuid(), role }).parse(body);
    return { team_id: input.team_id, user_id: parsed.userId, role: parsed.role };
  },
  before: async (input, call) => {
    const current = await currentRole(call, input.team_id, input.user_id);
    if (current === undefined) return notMember();
    return current === input.from_role ? "same" : "changed";
  },
  summary: (input) =>
    `Change the role of member ${input.user_id} in team ${input.team_id}: ${ROLE_LABEL[input.from_role]} → ${ROLE_LABEL[input.to_role]}`,
});

export const siteTeamMembersRemove = kobeTool({
  name: "site_team_members_remove",
  title: "Remove a team member",
  description:
    "Removes a member from a team (Site console › Teams › Manage members): their sandbox there " +
    "stops, their schedules there pause, their shared threads go private and their project " +
    "checkouts end; they can be added again. Give the team_id, the member's user_id and their " +
    "current role (from site_team_members_list). The last team admin, rows an identity provider " +
    "manages and your own membership can't be removed here. The person is always asked to " +
    "approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.teams.manage",
  readOnly: false,
  destructive: true,
  input: z.strictObject({ team_id: z.uuid(), user_id: z.uuid(), from_role: role }),
  output: z.strictObject({ team_id: z.uuid(), user_id: z.uuid(), removed: z.literal(true) }),
  route: (input) => ({
    method: "DELETE",
    path: `/site/teams/${input.team_id}/members/${input.user_id}`,
    query: { expectedRole: input.from_role },
  }),
  reduce: (_body, input) => ({
    team_id: input.team_id,
    user_id: input.user_id,
    removed: true as const,
  }),
  before: async (input, call) => {
    const current = await currentRole(call, input.team_id, input.user_id);
    if (current === undefined) return notMember();
    return current === input.from_role ? "same" : "changed";
  },
  summary: (input) =>
    `Remove member ${input.user_id} (${ROLE_LABEL[input.from_role]}) from team ${input.team_id}`,
});
