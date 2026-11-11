import { z } from "zod";
import { TEAM_ROLES, type TeamRole } from "@kobe/db";
import { cursorSchema, kobeTool, page, type KobeRouteCaller } from "../catalog.js";

/** Team console › Members (`/v1/team/members`, page permission `team.members.manage`). */

const role = z.enum(TEAM_ROLES as [TeamRole, ...TeamRole[]]);
const ROLE_LABEL: Readonly<Record<TeamRole, string>> = {
  member: "Member",
  contributor: "Contributor",
  team_admin: "Team admin",
};

const memberRow = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role,
});
const membersAnswer = z.object({ members: z.array(memberRow) });

const memberOut = z.strictObject({
  user_id: z.uuid(),
  name: z.string().max(200),
  email: z.string().max(320),
  role,
});

export const teamMembersList = kobeTool({
  name: "team_members_list",
  title: "List team members",
  description:
    "Lists the members of the conversation's team with their roles (Team console › Members). " +
    "Paged: pass next_cursor back as cursor for the next page.",
  scope: "team",
  permission: "team.members.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    members: z.array(memberOut).max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => ({ method: "GET", path: "/team/members" }),
  reduce: (body, input) => {
    const { members } = membersAnswer.parse(body);
    const { rows, next_cursor } = page(members, input.cursor);
    return {
      members: rows.map((m) => ({
        user_id: m.userId,
        name: m.name.slice(0, 200),
        email: m.email.slice(0, 320),
        role: m.role,
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

const setRoleInput = z.strictObject({
  user_id: z.uuid(),
  /** The role the person saw: the call is refused when it changed since the approval (§5). */
  from_role: role,
  to_role: role,
});

/** The member's current role as the person reads it, or undefined when not a member. */
async function currentRole(
  call: KobeRouteCaller,
  userId: string,
): Promise<TeamRole | undefined | "unreadable"> {
  const answer = await call({ method: "GET", path: "/team/members" });
  if (answer.status !== 200) return "unreadable";
  const parsed = membersAnswer.safeParse(answer.body);
  if (!parsed.success) return "unreadable";
  return parsed.data.members.find((m) => m.userId === userId)?.role;
}

export const teamMembersSetRole = kobeTool({
  name: "team_members_set_role",
  title: "Change a member's role",
  description:
    "Changes a team member's role (Team console › Members). Give the member's user_id, the role " +
    "they have now (from team_members_list) and the new role. The person is always asked to " +
    "approve; never retry a refused or denied call.",
  scope: "team",
  permission: "team.members.manage",
  readOnly: false,
  destructive: false,
  input: setRoleInput,
  output: z.strictObject({ user_id: z.uuid(), role }),
  // The approved before-state is a condition of the change itself (checked under its row lock).
  route: (input) => ({
    method: "PATCH",
    path: `/team/members/${input.user_id}`,
    body: { role: input.to_role, expectedRole: input.from_role },
  }),
  reduce: (body) => {
    const parsed = z.object({ userId: z.uuid(), role }).parse(body);
    return { user_id: parsed.userId, role: parsed.role };
  },
  before: async (input, call) => {
    const current = await currentRole(call, input.user_id);
    if (current === undefined) {
      return { code: "not_a_member", message: "That user is not a member of this team." };
    }
    return current === input.from_role ? "same" : "changed";
  },
  summary: (input) =>
    `Change the role of member ${input.user_id}: ${ROLE_LABEL[input.from_role]} → ${ROLE_LABEL[input.to_role]}`,
});
