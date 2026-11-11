import { z } from "zod";
import {
  cursorSchema,
  kobeTool,
  page,
  type BeforeState,
  type KobeRouteCaller,
} from "../catalog.js";
import { ROLE_LABEL, role } from "./team-members.js";

/** Team console › Invites (`/v1/team/invites`, page permission `team.members.manage`). */

const inviteRow = z.object({
  id: z.uuid(),
  email: z.string(),
  role,
  invitedBy: z.object({ id: z.uuid(), name: z.string() }),
  createdAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(["pending", "expired"]),
});
const invitesAnswer = z.object({ invitations: z.array(inviteRow) });

const inviteOut = z.strictObject({
  invitation_id: z.uuid(),
  email: z.string().max(254),
  role,
  status: z.enum(["pending", "expired"]),
  invited_by: z.string().max(200),
  expires_at: z.string().max(40),
});

export const teamInvitesList = kobeTool({
  name: "team_invites_list",
  title: "List team invitations",
  description:
    "Lists the team's open and expired invitations: address, offered role, who invited and when " +
    "it expires (Team console › Invites). Paged: pass next_cursor back as cursor.",
  scope: "team",
  permission: "team.members.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    invitations: z.array(inviteOut).max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => ({ method: "GET", path: "/team/invites" }),
  reduce: (body, input) => {
    const { rows, next_cursor } = page(invitesAnswer.parse(body).invitations, input.cursor);
    return {
      invitations: rows.map((i) => ({
        invitation_id: i.id,
        email: i.email.slice(0, 254),
        role: i.role,
        status: i.status,
        invited_by: i.invitedBy.name.slice(0, 200),
        expires_at: i.expiresAt,
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

const normalize = (email: string) => email.trim().toLowerCase();

/** The invitations the person reads now, or undefined when unreadable. */
async function invitations(call: KobeRouteCaller) {
  const answer = await call({ method: "GET", path: "/team/invites" });
  if (answer.status !== 200) return undefined;
  const parsed = invitesAnswer.safeParse(answer.body);
  return parsed.success ? parsed.data.invitations : undefined;
}

const createInput = z.strictObject({
  email: z.email().max(254),
  role,
  /**
   * The address's invitation as the person saw it (team_invites_list): its role, or null when it
   * has none. Inviting again renews it with the new role.
   */
  from_role: role.nullable(),
});

export const teamInvitesCreate = kobeTool({
  name: "team_invites_create",
  title: "Invite someone to the team",
  description:
    "Invites an email address into the conversation's team with a role, or renews its invitation " +
    "(Team console › Invites). Kobe emails the address; they join by accepting while signed in. " +
    "Give from_role: the address's current invitation role from team_invites_list, or null for " +
    "none. The person is always asked to approve; never retry a refused or denied call.",
  scope: "team",
  permission: "team.members.manage",
  readOnly: false,
  destructive: false,
  input: createInput,
  output: z.strictObject({
    invitation_id: z.uuid(),
    email: z.string().max(254),
    role,
    expires_at: z.string().max(40),
  }),
  route: (input) => ({
    method: "POST",
    path: "/team/invites",
    body: { email: input.email, role: input.role, expectedRole: input.from_role },
  }),
  reduce: (body) => {
    const { invitation } = z
      .object({
        invitation: z.object({ id: z.uuid(), email: z.string(), role, expiresAt: z.string() }),
      })
      .parse(body);
    return {
      invitation_id: invitation.id,
      email: invitation.email.slice(0, 254),
      role: invitation.role,
      expires_at: invitation.expiresAt,
    };
  },
  before: async (input, call): Promise<BeforeState> => {
    const all = await invitations(call);
    if (all === undefined) return "changed";
    const current = all.find((i) => i.email === normalize(input.email))?.role ?? null;
    return current === input.from_role ? "same" : "changed";
  },
  summary: (input) =>
    input.from_role === null
      ? `Invite ${input.email} to the team as ${ROLE_LABEL[input.role]}`
      : `Renew the invitation of ${input.email}: ${ROLE_LABEL[input.from_role]} → ${ROLE_LABEL[input.role]}`,
});

const revokeInput = z.strictObject({
  invitation_id: z.uuid(),
  /** The invitation's role as the person saw it (team_invites_list). */
  from_role: role,
});

export const teamInvitesRevoke = kobeTool({
  name: "team_invites_revoke",
  title: "Revoke an invitation",
  description:
    "Revokes an open team invitation so it can no longer be accepted (Team console › Invites); " +
    "the address can be invited again. Give the invitation_id and its role from " +
    "team_invites_list. The person is always asked to approve; never retry a refused or denied call.",
  scope: "team",
  permission: "team.members.manage",
  readOnly: false,
  destructive: false,
  input: revokeInput,
  output: z.strictObject({ invitation_id: z.uuid(), revoked: z.literal(true) }),
  route: (input) => ({
    method: "DELETE",
    path: `/team/invites/${input.invitation_id}`,
    query: { expectedRole: input.from_role },
  }),
  reduce: (_body, input) => ({ invitation_id: input.invitation_id, revoked: true as const }),
  before: async (input, call): Promise<BeforeState> => {
    const all = await invitations(call);
    if (all === undefined) return "changed";
    const current = all.find((i) => i.id === input.invitation_id);
    if (current === undefined) {
      return { code: "invitation_not_found", message: "No invitation with that id." };
    }
    return current.role === input.from_role ? "same" : "changed";
  },
  summary: (input) => `Revoke invitation ${input.invitation_id} (${ROLE_LABEL[input.from_role]})`,
});
