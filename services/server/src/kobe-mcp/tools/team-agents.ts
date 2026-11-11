import { z } from "zod";
import { kobeTool, routeCursorSchema, type BeforeState, type KobeRouteCaller } from "../catalog.js";

/**
 * The team's agents (Agents › Team tab with the admins' inventory, KOBE-570; Team console
 * permission `team.agents.suspend`): the roster and this team's suspensions. Transfers are an
 * owner's own offer of their agent, not a Team console action, so no tool offers them.
 */

const statusSchema = z.enum([
  "active",
  "proposed",
  "not_published",
  "suspended_here",
  "suspended_site",
  "unavailable",
  "archived",
]);

const rosterRow = z.object({
  agentId: z.uuid(),
  kind: z.string(),
  slug: z.string(),
  name: z.string(),
  ownerName: z.string().nullable(),
  status: statusSchema,
  currentVersion: z.number().nullable(),
  versionInEffect: z.number().nullable(),
  entry: z.object({ state: z.string() }).nullable(),
  usage: z
    .object({ runCount: z.number(), lastRunAt: z.string().nullable(), tokens: z.number() })
    .optional(),
});
const rosterAnswer = z.object({ rows: z.array(rosterRow), nextCursor: z.string().nullable() });

export const teamAgentsList = kobeTool({
  name: "team_agents_list",
  title: "List the team's agents",
  description:
    "Lists the agents on the conversation's team roster: kind (team_owned, personal, gallery), " +
    "owner, status (active, proposed, suspended_here, suspended_site, …), the version in effect " +
    "and the team's usage (Agents › Team). Paged: pass next_cursor back as cursor.",
  scope: "team",
  permission: "team.agents.suspend",
  readOnly: true,
  input: z.strictObject({ cursor: routeCursorSchema.optional() }),
  output: z.strictObject({
    agents: z
      .array(
        z.strictObject({
          agent_id: z.uuid(),
          name: z.string().max(200),
          slug: z.string().max(100),
          kind: z.string().max(20),
          owner: z.string().max(200).nullable(),
          status: statusSchema,
          roster_entry: z.string().max(20).nullable(),
          version_in_effect: z.number().nullable(),
          runs: z.number().int().nonnegative().optional(),
          last_run_at: z.string().max(40).nullable().optional(),
        }),
      )
      .max(50),
    next_cursor: routeCursorSchema.optional(),
  }),
  route: (input) => ({
    method: "GET",
    path: "/agents/roster",
    query: {
      tab: "team",
      limit: "50",
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
  }),
  reduce: (body) => {
    const answer = rosterAnswer.parse(body);
    return {
      agents: answer.rows.slice(0, 50).map((r) => ({
        agent_id: r.agentId,
        name: r.name.slice(0, 200),
        slug: r.slug.slice(0, 100),
        kind: r.kind.slice(0, 20),
        owner: r.ownerName?.slice(0, 200) ?? null,
        status: r.status,
        roster_entry: r.entry?.state.slice(0, 20) ?? null,
        version_in_effect: r.versionInEffect,
        ...(r.usage === undefined
          ? {}
          : { runs: r.usage.runCount, last_run_at: r.usage.lastRunAt }),
      })),
      ...(answer.nextCursor !== null && routeCursorSchema.safeParse(answer.nextCursor).success
        ? { next_cursor: answer.nextCursor }
        : {}),
    };
  },
});

const ROSTER_PAGES = 10;

/** The agent's row on the team roster as the person reads it (up to 10 pages of 50). */
async function rowOf(call: KobeRouteCaller, agentId: string) {
  let cursor: string | undefined;
  for (let i = 0; i < ROSTER_PAGES; i++) {
    const answer = await call({
      method: "GET",
      path: "/agents/roster",
      query: { tab: "team", limit: "50", ...(cursor === undefined ? {} : { cursor }) },
    });
    if (answer.status !== 200) return "unreadable" as const;
    const parsed = rosterAnswer.safeParse(answer.body);
    if (!parsed.success) return "unreadable" as const;
    const found = parsed.data.rows.find((r) => r.agentId === agentId);
    if (found !== undefined) return found;
    if (parsed.data.nextCursor === null) return undefined;
    cursor = parsed.data.nextCursor;
  }
  return "unreadable" as const;
}

const NOT_ON_ROSTER = {
  code: "roster_entry_not_found",
  message: "This agent is not on the team's roster.",
};

function suspensionTool(suspend: boolean) {
  return kobeTool({
    name: suspend ? "team_agents_suspend" : "team_agents_resume",
    title: suspend ? "Suspend an agent for the team" : "Resume an agent for the team",
    description: suspend
      ? "Suspends an agent in the conversation's team: nobody here can start it and its schedules " +
        "here pause (Agents › Team); team_agents_resume undoes it. Give an agent whose status in " +
        "team_agents_list is not suspended_here. The person is always asked to approve; never " +
        "retry a refused or denied call."
      : "Resumes an agent this team suspended (status suspended_here in team_agents_list), so " +
        "the team can run it again (Agents › Team). A site admin's suspension (suspended_site) " +
        "stays. The person is always asked to approve; never retry a refused or denied call.",
    scope: "team",
    permission: "team.agents.suspend",
    readOnly: false,
    destructive: false,
    input: z.strictObject({
      agent_id: z.uuid(),
      /** Whether the team suspends it now, as the person saw it (status suspended_here). */
      from_suspended: z.literal(!suspend),
    }),
    output: z.strictObject({ agent_id: z.uuid(), suspended_here: z.boolean() }),
    route: (input) => ({
      method: "PUT",
      path: `/team/agent-roster/${input.agent_id}`,
      query: { expectedSuspended: String(!suspend) },
      body: { state: suspend ? "suspended" : "active" },
    }),
    reduce: (body, input) => {
      const parsed = z.object({ suspendedHere: z.boolean() }).safeParse(body);
      return {
        agent_id: input.agent_id,
        suspended_here: parsed.success ? parsed.data.suspendedHere : suspend,
      };
    },
    before: async (input, call): Promise<BeforeState> => {
      const row = await rowOf(call, input.agent_id);
      if (row === "unreadable") return "changed";
      if (row === undefined) return NOT_ON_ROSTER;
      return (row.status === "suspended_here") === input.from_suspended ? "same" : "changed";
    },
    summary: (input) => `${suspend ? "Suspend" : "Resume"} agent ${input.agent_id} in this team`,
  });
}

export const teamAgentsSuspend = suspensionTool(true);
export const teamAgentsResume = suspensionTool(false);
