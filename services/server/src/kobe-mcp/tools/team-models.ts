import { z } from "zod";
import { MODEL_ALIAS_PATTERN, THINKING_LEVELS } from "@kobe/db";
import {
  cursorSchema,
  kobeTool,
  page,
  segment,
  type BeforeState,
  type KobeRouteCaller,
} from "../catalog.js";

/** Team console › Models (`/v1/team/models`, page permission `team.models.manage`). */

const alias = z.string().max(64).regex(new RegExp(MODEL_ALIAS_PATTERN));
const thinking = z.enum(THINKING_LEVELS).nullable();

const modelRow = z.object({
  alias: z.string(),
  label: z.string().nullable(),
  enabled: z.boolean(),
  is_default: z.boolean(),
  thinking_max: thinking,
});
const modelsAnswer = z.object({ models: z.array(modelRow) });

const setting = z.strictObject({
  enabled: z.boolean(),
  is_default: z.boolean(),
  thinking_max: thinking,
});

export const teamModelsList = kobeTool({
  name: "team_models_list",
  title: "List team models",
  description:
    "Lists the site's model catalog with this team's choice: enabled, the team default, and the " +
    "team's thinking maximum (null: the site's) (Team console › Models). Paged: pass next_cursor " +
    "back as cursor.",
  scope: "team",
  permission: "team.models.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    models: z
      .array(
        z.strictObject({
          alias: z.string().max(64),
          label: z.string().max(200).nullable(),
          enabled: z.boolean(),
          is_default: z.boolean(),
          thinking_max: thinking,
        }),
      )
      .max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => ({ method: "GET", path: "/team/models" }),
  reduce: (body, input) => {
    const { rows, next_cursor } = page(modelsAnswer.parse(body).models, input.cursor);
    return {
      models: rows.map((m) => ({
        alias: m.alias,
        label: m.label?.slice(0, 200) ?? null,
        enabled: m.enabled,
        is_default: m.is_default,
        thinking_max: m.thinking_max,
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

async function currentSetting(call: KobeRouteCaller, name: string) {
  const answer = await call({ method: "GET", path: "/team/models" });
  if (answer.status !== 200) return "unreadable" as const;
  const parsed = modelsAnswer.safeParse(answer.body);
  if (!parsed.success) return "unreadable" as const;
  return parsed.data.models.find((m) => m.alias === name);
}

const setInput = z.strictObject({
  alias: alias,
  /** The team's setting as the person saw it (team_models_list). */
  from: setting,
  to: z.strictObject({
    enabled: z.boolean(),
    /** Make it the team's default (needs enabled). */
    is_default: z.boolean().optional(),
    /** Lower the thinking maximum, or null for the site's. */
    thinking_max: thinking.optional(),
  }),
});

const label = (s: { enabled: boolean; is_default?: boolean | undefined }) =>
  !s.enabled ? "disabled" : s.is_default ? "enabled, default" : "enabled";

export const teamModelsSet = kobeTool({
  name: "team_models_set",
  title: "Enable or disable a model for the team",
  description:
    "Enables or disables a catalog model for the conversation's team, makes it the team default, " +
    "or changes the team's thinking maximum for it (Team console › Models). Give from exactly as " +
    "team_models_list shows the model. The person is always asked to approve; never retry a " +
    "refused or denied call.",
  scope: "team",
  permission: "team.models.manage",
  readOnly: false,
  destructive: false,
  input: setInput,
  output: z.strictObject({ alias: z.string().max(64), ...setting.shape }),
  route: (input) => ({
    method: "PUT",
    path: `/team/models/${segment(input.alias)}`,
    body: { ...input.to, expected: input.from },
  }),
  reduce: (body, input) => {
    const row = modelsAnswer.parse(body).models.find((m) => m.alias === input.alias);
    if (row === undefined) throw new Error("kobe-mcp: the model left the catalog");
    return {
      alias: row.alias,
      enabled: row.enabled,
      is_default: row.is_default,
      thinking_max: row.thinking_max,
    };
  },
  before: async (input, call): Promise<BeforeState> => {
    const current = await currentSetting(call, input.alias);
    if (current === "unreadable") return "changed";
    if (current === undefined) {
      return { code: "model_not_found", message: "That model is not in the site's catalog." };
    }
    return current.enabled === input.from.enabled &&
      current.is_default === input.from.is_default &&
      current.thinking_max === input.from.thinking_max
      ? "same"
      : "changed";
  },
  summary: (input) =>
    `Model ${input.alias}: ${label(input.from)} → ${label(input.to)}` +
    (input.to.thinking_max === undefined
      ? ""
      : `, thinking maximum ${input.from.thinking_max ?? "site's"} → ${input.to.thinking_max ?? "site's"}`),
});
