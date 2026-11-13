import { z } from "zod";
import { kobeTool, type BeforeState } from "../catalog.js";
import {
  WORKSPACE_WIRE_KEYS,
  workspaceMemoryWireSchema,
  type WorkspaceMemoryWire,
} from "../../memory/settings-wire.js";

/**
 * Workspace settings › Memory (`/v1/memory/settings?level=team`, page permission
 * `team.memory.manage`): the Workspace's memory switches and learning model override (KOBE-381).
 * What applies is their AND with the Site's. Input and output use the route's own wire schema
 * (`memory/settings-wire.ts`), so the tools and the console cannot drift.
 */

const switches = workspaceMemoryWireSchema;
const TEAM = { level: "team" } as const;

const SWITCHES_HELP =
  "memory_enabled (master: Notes and Memories in this workspace), project_memory_enabled " +
  "(project Notes), memories_enabled (Memories), workspace_memories_enabled (Workspace " +
  "memories), site_memories_enabled (Site memories reach this workspace's runs; Site Policy " +
  "reaches them anyway), learn_enabled (Learn from this chat), site_proposals_enabled (members " +
  "may propose memories to the Site) and learning_model_alias (the workspace's learning model, " +
  "used when the Site's isn't enabled here; null = none; must be a model enabled in the workspace)";

export const teamMemoryGet = kobeTool({
  name: "team_memory_get",
  title: "Read the workspace's memory settings",
  description:
    `Reads the conversation's workspace memory settings (Workspace settings › Memory): ${SWITCHES_HELP}. ` +
    "A site admin's switch can still turn any of them off for every workspace.",
  scope: "team",
  permission: "team.memory.manage",
  readOnly: true,
  input: z.strictObject({}),
  output: switches,
  route: () => ({ method: "GET", path: "/memory/settings", query: TEAM }),
  reduce: (body) => switches.parse(body),
});

const setInput = z.strictObject({
  /** The workspace's settings as the person saw them (team_memory_get), every key. */
  from: switches,
  to: switches.partial().refine((v) => Object.keys(v).length > 0, "nothing to change"),
});

const show = (v: boolean | string | null) =>
  v === true ? "on" : v === false ? "off" : v === null ? "none" : v;

const LABELS: Readonly<Record<keyof WorkspaceMemoryWire, string>> = {
  memory_enabled: "Memory (master)",
  project_memory_enabled: "Project notes",
  memories_enabled: "Memories",
  workspace_memories_enabled: "Workspace memories",
  site_memories_enabled: "Site memories in this workspace",
  learn_enabled: "Learn from this chat",
  site_proposals_enabled: "Propose to the Site",
  learning_model_alias: "Learning model",
};

/** True when the current settings are exactly the approved before-state. */
export function sameMemorySettings(a: WorkspaceMemoryWire, b: WorkspaceMemoryWire): boolean {
  return WORKSPACE_WIRE_KEYS.every((k) => a[k] === b[k]);
}

export const teamMemorySet = kobeTool({
  name: "team_memory_set",
  title: "Change the workspace's memory settings",
  description:
    `Changes the conversation's workspace memory settings (Workspace settings › Memory): ${SWITCHES_HELP}. ` +
    "Turning one off keeps every stored note and memory; it stops their use. Give from exactly " +
    "as team_memory_get shows it (every key), and in to only what changes. The person is always " +
    "asked to approve; never retry a refused or denied call.",
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
  reduce: (body) => switches.parse(body),
  before: async (input, call): Promise<BeforeState> => {
    const answer = await call({ method: "GET", path: "/memory/settings", query: TEAM });
    const s = answer.status === 200 ? switches.safeParse(answer.body) : undefined;
    if (!s?.success) return "changed";
    return sameMemorySettings(s.data, input.from) ? "same" : "changed";
  },
  summary: (input) =>
    WORKSPACE_WIRE_KEYS.filter((k) => input.to[k] !== undefined)
      .map(
        (k) =>
          `${LABELS[k]}: ${show(input.from[k])} → ${show(input.to[k] as boolean | string | null)}`,
      )
      .join("; "),
});
