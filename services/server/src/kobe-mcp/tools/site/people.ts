import { z } from "zod";
import { cursorSchema, kobeTool, page } from "../../catalog.js";
import { teamNameSchema, teamSlugSchema } from "../../../teams/schemas.js";
import { clip, matches, missing, querySchema, readAs } from "./shared.js";

/**
 * Site console › Users, Teams and Invitations (KOBE-622): `/v1/site/users` and `/v1/site/invites`
 * (page permission `site.users.manage`), `/v1/site/teams` (`site.teams.manage`).
 */

const SITE_ROLE = z.enum(["user", "admin", "owner"]);
const userRow = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  siteRole: SITE_ROLE,
  twoFactorEnabled: z.boolean(),
  deactivatedAt: z.string().nullable(),
});
const usersAnswer = z.object({ users: z.array(userRow) });
const USERS = { method: "GET", path: "/site/users" } as const;

const userOut = z.strictObject({
  user_id: z.uuid(),
  name: z.string().max(200),
  email: z.string().max(320),
  site_role: SITE_ROLE,
  two_factor: z.boolean(),
  deactivated: z.boolean(),
});

export const siteUsersList = kobeTool({
  name: "site_users_list",
  title: "List Kobe users",
  description:
    "Lists every Kobe account on the site with its site role, two-factor status and whether it is " +
    "deactivated (Site console › Users). Optional `query` filters by name or email; `state` " +
    "filters active or deactivated accounts. Paged: pass next_cursor back as cursor.",
  scope: "site",
  permission: "site.users.manage",
  readOnly: true,
  input: z.strictObject({
    cursor: cursorSchema.optional(),
    query: querySchema.optional(),
    state: z.enum(["active", "deactivated", "all"]).optional(),
  }),
  output: z.strictObject({
    users: z.array(userOut).max(50),
    total: z.number().int(),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => USERS,
  reduce: (body, input) => {
    const state = input.state ?? "all";
    const all = usersAnswer
      .parse(body)
      .users.filter((u) => matches(input.query, u.name, u.email))
      .filter((u) => state === "all" || (state === "active") === (u.deactivatedAt === null));
    const { rows, next_cursor } = page(all, input.cursor);
    return {
      users: rows.map((u) => ({
        user_id: u.id,
        name: clip(u.name, 200),
        email: clip(u.email, 320),
        site_role: u.siteRole,
        two_factor: u.twoFactorEnabled,
        deactivated: u.deactivatedAt !== null,
      })),
      total: all.length,
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

/** The user's activation as the person reads it, or undefined when there is no such user. */
async function activation(call: Parameters<typeof readAs>[0], userId: string) {
  const answer = await readAs(call, USERS, usersAnswer);
  if (answer === undefined) return "unreadable" as const;
  const user = answer.users.find((u) => u.id === userId);
  if (user === undefined) return undefined;
  return user.deactivatedAt === null ? ("active" as const) : ("deactivated" as const);
}

const activationOut = z.strictObject({
  user_id: z.uuid(),
  deactivated: z.boolean(),
  teams_without_active_admin: z
    .array(z.strictObject({ team_id: z.uuid(), name: z.string().max(100) }))
    .max(50)
    .optional(),
  incomplete_steps: z.array(z.string().max(100)).max(20).optional(),
});
const activationAnswer = z.object({
  userId: z.uuid(),
  deactivated: z.boolean(),
  teamsWithoutActiveAdmin: z.array(z.object({ id: z.uuid(), name: z.string() })).optional(),
  incompleteSteps: z.array(z.string()).optional(),
});
function activationResult(body: unknown) {
  const a = activationAnswer.parse(body);
  return {
    user_id: a.userId,
    deactivated: a.deactivated,
    ...(a.teamsWithoutActiveAdmin === undefined
      ? {}
      : {
          teams_without_active_admin: a.teamsWithoutActiveAdmin
            .slice(0, 50)
            .map((t) => ({ team_id: t.id, name: clip(t.name, 100) })),
        }),
    ...(a.incompleteSteps === undefined || a.incompleteSteps.length === 0
      ? {}
      : { incomplete_steps: a.incompleteSteps.slice(0, 20).map((s) => clip(s, 100)) }),
  };
}

const NO_USER = missing("user_not_found", "No Kobe user with that id.");

export const siteUsersDeactivate = kobeTool({
  name: "site_users_deactivate",
  title: "Deactivate a user",
  description:
    "Deactivates a Kobe account (Site console › Users): it can no longer sign in, every session " +
    "ends at once, and its team memberships are kept for a later reactivation. Give the user_id " +
    "and from_state `active` (from site_users_list). Only the Owner may deactivate an Admin; the " +
    "Owner cannot be deactivated. The person is always asked to approve; never retry a refused " +
    "or denied call.",
  scope: "site",
  permission: "site.users.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ user_id: z.uuid(), from_state: z.literal("active") }),
  output: activationOut,
  route: (input) => ({
    method: "POST",
    path: `/site/users/${input.user_id}/deactivate`,
    body: { expectedState: input.from_state },
  }),
  reduce: (body) => activationResult(body),
  before: async (input, call) => {
    const state = await activation(call, input.user_id);
    if (state === undefined) return NO_USER;
    return state === input.from_state ? "same" : "changed";
  },
  summary: (input) =>
    `Deactivate user ${input.user_id} (signed out everywhere; memberships kept for reactivation)`,
});

export const siteUsersReactivate = kobeTool({
  name: "site_users_reactivate",
  title: "Reactivate a user",
  description:
    "Reactivates a deactivated Kobe account (Site console › Users); it signs in again with its " +
    "existing credentials and gets its teams back. Give the user_id and from_state `deactivated` " +
    "(from site_users_list). The person is always asked to approve; never retry a refused or " +
    "denied call.",
  scope: "site",
  permission: "site.users.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ user_id: z.uuid(), from_state: z.literal("deactivated") }),
  output: activationOut,
  route: (input) => ({
    method: "POST",
    path: `/site/users/${input.user_id}/reactivate`,
    body: { expectedState: input.from_state },
  }),
  reduce: (body) => activationResult(body),
  before: async (input, call) => {
    const state = await activation(call, input.user_id);
    if (state === undefined) return NO_USER;
    return state === input.from_state ? "same" : "changed";
  },
  summary: (input) => `Reactivate user ${input.user_id}`,
});

const teamRow = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
const TEAMS = { method: "GET", path: "/site/teams" } as const;
const teamOut = z.strictObject({
  team_id: z.uuid(),
  slug: z.string().max(32),
  name: z.string().max(100),
  created_at: z.string().max(40),
});

export const siteTeamsList = kobeTool({
  name: "site_teams_list",
  title: "List teams",
  description:
    "Lists every team on the site with its slug and name (Site console › Teams; metadata only, " +
    "never team content). Optional `query` filters by name or slug. Paged: pass next_cursor back " +
    "as cursor.",
  scope: "site",
  permission: "site.teams.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional(), query: querySchema.optional() }),
  output: z.strictObject({
    teams: z.array(teamOut).max(50),
    total: z.number().int(),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => TEAMS,
  reduce: (body, input) => {
    const all = z
      .object({ teams: z.array(teamRow) })
      .parse(body)
      .teams.filter((t) => matches(input.query, t.name, t.slug));
    const { rows, next_cursor } = page(all, input.cursor);
    return {
      teams: rows.map((t) => ({
        team_id: t.id,
        slug: t.slug,
        name: clip(t.name, 100),
        created_at: t.createdAt,
      })),
      total: all.length,
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

export const siteTeamsCreate = kobeTool({
  name: "site_teams_create",
  title: "Create a team",
  description:
    "Creates a team and names its first team admin (Site console › Teams). Give a slug (1-32 " +
    "lowercase letters, digits or hyphens; it cannot be changed later), a display name and the " +
    "admin's user_id (from site_users_list). Add more members with site_team_members_add. The " +
    "person is always asked to approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.teams.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ slug: teamSlugSchema, name: teamNameSchema, admin_user_id: z.uuid() }),
  output: z.strictObject({
    team_id: z.uuid(),
    slug: z.string().max(32),
    name: z.string().max(100),
  }),
  route: (input) => ({
    method: "POST",
    path: "/site/teams",
    body: { slug: input.slug, name: input.name, adminUserId: input.admin_user_id },
  }),
  reduce: (body) => {
    const { team } = z
      .object({ team: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }) })
      .parse(body);
    return { team_id: team.id, slug: team.slug, name: clip(team.name, 100) };
  },
  // The before-state of a creation is "no such team"; the route's unique slug decides the race.
  before: async (input, call) => {
    const answer = await readAs(call, TEAMS, z.object({ teams: z.array(teamRow) }));
    if (answer?.teams.some((t) => t.slug === input.slug)) {
      return missing("slug_taken", "Another team already uses that slug.");
    }
    return "same";
  },
  summary: (input) =>
    `Create team "${input.name}" (slug ${input.slug}) with user ${input.admin_user_id} as its team admin`,
});

const inviteRow = z.object({
  id: z.uuid(),
  email: z.string(),
  invitedBy: z.object({ id: z.uuid(), name: z.string() }),
  createdAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(["pending", "expired"]),
});
const invitesAnswer = z.object({ invitations: z.array(inviteRow) });
const INVITES = { method: "GET", path: "/site/invites" } as const;

export const siteInvitesList = kobeTool({
  name: "site_invites_list",
  title: "List site invitations",
  description:
    "Lists the open invitations to create a Kobe account (Site console › Users › Invitations), " +
    "pending or expired. Paged: pass next_cursor back as cursor.",
  scope: "site",
  permission: "site.users.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    invitations: z
      .array(
        z.strictObject({
          invitation_id: z.uuid(),
          email: z.string().max(320),
          invited_by: z.string().max(200),
          expires_at: z.string().max(40),
          status: z.enum(["pending", "expired"]),
        }),
      )
      .max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => INVITES,
  reduce: (body, input) => {
    const { rows, next_cursor } = page(invitesAnswer.parse(body).invitations, input.cursor);
    return {
      invitations: rows.map((i) => ({
        invitation_id: i.id,
        email: clip(i.email, 320),
        invited_by: clip(i.invitedBy.name, 200),
        expires_at: i.expiresAt,
        status: i.status,
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

export const siteInvitesCreate = kobeTool({
  name: "site_invites_create",
  title: "Invite someone to Kobe",
  description:
    "Invites an email address to create a Kobe account (Site console › Users › Invite); Kobe " +
    "emails the invitation. Joining a team is a separate team invitation from that team's admin. " +
    "Refused when the address already has an account. The person is always asked to approve; " +
    "never retry a refused or denied call.",
  scope: "site",
  permission: "site.users.manage",
  readOnly: false,
  destructive: false,
  input: z.strictObject({ email: z.email().max(254) }),
  output: z.strictObject({
    invitation_id: z.uuid(),
    email: z.string().max(320),
    expires_at: z.string().max(40),
    email_sent: z.boolean(),
  }),
  route: (input) => ({ method: "POST", path: "/site/invites", body: { email: input.email } }),
  reduce: (body) => {
    const a = z
      .object({
        invitation: z.object({ id: z.uuid(), email: z.string(), expiresAt: z.string() }),
        emailSent: z.boolean(),
      })
      .parse(body);
    return {
      invitation_id: a.invitation.id,
      email: clip(a.invitation.email, 320),
      expires_at: a.invitation.expiresAt,
      email_sent: a.emailSent,
    };
  },
  // A new invitation has no before-state; the route refuses an address with an account.
  before: () => Promise.resolve("same"),
  summary: (input) => `Invite ${input.email} to create a Kobe account (sends an email)`,
});

export const siteInvitesRevoke = kobeTool({
  name: "site_invites_revoke",
  title: "Revoke a site invitation",
  description:
    "Revokes an open invitation to create a Kobe account (Site console › Users › Invitations): " +
    "its link stops working. Give the invitation_id and its email (from site_invites_list). The " +
    "person is always asked to approve; never retry a refused or denied call.",
  scope: "site",
  permission: "site.users.manage",
  readOnly: false,
  destructive: true,
  input: z.strictObject({ invitation_id: z.uuid(), email: z.email().max(254) }),
  output: z.strictObject({ invitation_id: z.uuid(), revoked: z.literal(true) }),
  route: (input) => ({
    method: "DELETE",
    path: `/site/invites/${input.invitation_id}`,
    query: { expectedEmail: input.email },
  }),
  reduce: (_body, input) => ({ invitation_id: input.invitation_id, revoked: true as const }),
  before: async (input, call) => {
    const answer = await readAs(call, INVITES, invitesAnswer);
    const invite = answer?.invitations.find((i) => i.id === input.invitation_id);
    if (invite === undefined) {
      return missing("invitation_not_found", "No open invitation with that id.");
    }
    return invite.email.toLowerCase() === input.email.toLowerCase() ? "same" : "changed";
  },
  summary: (input) => `Revoke the invitation of ${input.email}`,
});
