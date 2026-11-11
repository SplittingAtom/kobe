import { z } from "zod";
import { kobeTool, type BeforeState } from "../catalog.js";

/**
 * Team console › Memory (`/v1/memory/settings?level=team`, page permission `team.memory.manage`):
 * the team's two switches. What applies is their AND with the site's.
 */

const switches = z.strictObject({
  memory_enabled: z.boolean(),
  project_memory_enabled: z.boolean(),
});
const switchesAnswer = z.object({
  memory_enabled: z.boolean(),
  project_memory_enabled: z.boolean(),
});
const TEAM = { level: "team" } as const;

export const teamMemoryGet = kobeTool({
  name: "team_memory_get",
  title: "Read the team's memory switches",
  description:
    "Reads the conversation's team memory switches: memory_enabled (people's memories in this " +
    "team) and project_memory_enabled (project memories) (Team console › Memory). A site admin's " +
    "switch can still turn either off for every team.",
  scope: "team",
  permission: "team.memory.manage",
  readOnly: true,
  input: z.strictObject({}),
  output: switches,
  route: () => ({ method: "GET", path: "/memory/settings", query: TEAM }),
  reduce: (body) => {
    const s = switchesAnswer.parse(body);
    return { memory_enabled: s.memory_enabled, project_memory_enabled: s.project_memory_enabled };
  },
});

const setInput = z.strictObject({
  /** The team's switches as the person saw them (team_memory_get). */
  from: switches,
  to: switches.partial().refine((v) => Object.keys(v).length > 0, "nothing to change"),
});

const onOff = (v: boolean) => (v ? "on" : "off");

export const teamMemorySet = kobeTool({
  name: "team_memory_set",
  title: "Change the team's memory switches",
  description:
    "Turns the conversation's team memory switches on or off (Team console › Memory); turning " +
    "one off keeps the stored memories, it stops their use. Give from exactly as team_memory_get " +
    "shows them, and in to only the switches to change. The person is always asked to approve; " +
    "never retry a refused or denied call.",
  scope: "team",
  permission: "team.memory.manage",
  readOnly: false,
  destructive: false,
  input: setInput,
  output: switches,
  route: (input) => ({
    method: "PUT",
    path: "/memory/settings",
    query: TEAM,
    body: { ...input.to, expected: input.from },
  }),
  reduce: (body) => {
    const s = switchesAnswer.parse(body);
    return { memory_enabled: s.memory_enabled, project_memory_enabled: s.project_memory_enabled };
  },
  before: async (input, call): Promise<BeforeState> => {
    const answer = await call({ method: "GET", path: "/memory/settings", query: TEAM });
    const s = answer.status === 200 ? switchesAnswer.safeParse(answer.body) : undefined;
    if (!s?.success) return "changed";
    return s.data.memory_enabled === input.from.memory_enabled &&
      s.data.project_memory_enabled === input.from.project_memory_enabled
      ? "same"
      : "changed";
  },
  summary: (input) =>
    (["memory_enabled", "project_memory_enabled"] as const)
      .filter((k) => input.to[k] !== undefined)
      .map(
        (k) =>
          `${k === "memory_enabled" ? "Memory" : "Project memory"}: ${onOff(input.from[k])} → ${onOff(input.to[k] ?? input.from[k])}`,
      )
      .join("; "),
});
