import { z } from "zod";
import {
  cursorSchema,
  kobeTool,
  page,
  type BeforeState,
  type KobeRouteCaller,
} from "../catalog.js";

/**
 * Team console › Schedules (`/v1/schedules?scope=team`, page permission `team.schedules.pause`):
 * every member's scheduled runs; a team admin pauses one, and resumes one a team admin paused.
 * A schedule's prompt is its owner's text and is not returned.
 */

const scheduleRow = z.object({
  schedule_id: z.uuid(),
  user_id: z.uuid(),
  agent_id: z.uuid(),
  recurrence: z.unknown(),
  tz: z.string(),
  active: z.boolean(),
  paused_by: z.string().nullable(),
  next_due_at: z.string().nullable(),
});
const schedulesAnswer = z.object({ schedules: z.array(scheduleRow) });
const TEAM = { scope: "team" } as const;

export const teamSchedulesList = kobeTool({
  name: "team_schedules_list",
  title: "List the team's schedules",
  description:
    "Lists every member's scheduled runs in the conversation's team: owner, agent, recurrence, " +
    "time zone, active or paused (and by whom) and the next run (Team console › Schedules). " +
    "Prompts are not shown. Paged: pass next_cursor back as cursor.",
  scope: "team",
  permission: "team.schedules.pause",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    schedules: z
      .array(
        z.strictObject({
          schedule_id: z.uuid(),
          owner_user_id: z.uuid(),
          agent_id: z.uuid(),
          recurrence: z.string().max(400),
          tz: z.string().max(64),
          active: z.boolean(),
          paused_by: z.string().max(40).nullable(),
          next_due_at: z.string().max(40).nullable(),
        }),
      )
      .max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => ({ method: "GET", path: "/schedules", query: TEAM }),
  reduce: (body, input) => {
    const { rows, next_cursor } = page(schedulesAnswer.parse(body).schedules, input.cursor);
    return {
      schedules: rows.map((s) => ({
        schedule_id: s.schedule_id,
        owner_user_id: s.user_id,
        agent_id: s.agent_id,
        recurrence: JSON.stringify(s.recurrence).slice(0, 400),
        tz: s.tz.slice(0, 64),
        active: s.active,
        paused_by: s.paused_by?.slice(0, 40) ?? null,
        next_due_at: s.next_due_at,
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

async function scheduleOf(call: KobeRouteCaller, id: string) {
  const answer = await call({ method: "GET", path: "/schedules", query: TEAM });
  if (answer.status !== 200) return "unreadable" as const;
  const parsed = schedulesAnswer.safeParse(answer.body);
  if (!parsed.success) return "unreadable" as const;
  return parsed.data.schedules.find((s) => s.schedule_id === id);
}

function pauseTool(pause: boolean) {
  return kobeTool({
    name: pause ? "team_schedules_pause" : "team_schedules_resume",
    title: pause ? "Pause a schedule" : "Resume a schedule",
    description: pause
      ? "Pauses a member's scheduled run in the conversation's team (Team console › Schedules); " +
        "only a team admin can resume it then. Give an active schedule from team_schedules_list. " +
        "The person is always asked to approve; never retry a refused or denied call."
      : "Resumes a schedule a team admin paused (paused_by team_admin in team_schedules_list); one " +
        "its owner paused is theirs to resume. The person is always asked to approve; never retry " +
        "a refused or denied call.",
    scope: "team",
    permission: "team.schedules.pause",
    readOnly: false,
    destructive: false,
    input: z.strictObject({
      schedule_id: z.uuid(),
      /** Whether it runs now, as the person saw it (team_schedules_list). */
      from_active: z.literal(pause),
    }),
    output: z.strictObject({ schedule_id: z.uuid(), active: z.boolean() }),
    route: (input) => ({
      method: "POST",
      path: `/schedules/${input.schedule_id}/${pause ? "pause" : "resume"}`,
      query: { expectedActive: String(pause) },
    }),
    reduce: (body) => {
      const parsed = z.object({ schedule_id: z.uuid(), active: z.boolean() }).parse(body);
      return { schedule_id: parsed.schedule_id, active: parsed.active };
    },
    before: async (input, call): Promise<BeforeState> => {
      const row = await scheduleOf(call, input.schedule_id);
      if (row === "unreadable") return "changed";
      if (row === undefined) {
        return { code: "schedule_not_found", message: "No schedule with that id." };
      }
      return row.active === input.from_active ? "same" : "changed";
    },
    summary: (input) => `${pause ? "Pause" : "Resume"} schedule ${input.schedule_id}`,
  });
}

export const teamSchedulesPause = pauseTool(true);
export const teamSchedulesResume = pauseTool(false);
