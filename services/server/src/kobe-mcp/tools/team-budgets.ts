import { z } from "zod";
import { MAX_BUDGET_TOKENS, MAX_BUDGET_USD, MAX_REQUESTS_PER_MINUTE } from "@kobe/db";
import {
  cursorSchema,
  kobeTool,
  page,
  type BeforeState,
  type KobeRouteCaller,
} from "../catalog.js";

/**
 * Team console › Budgets (`/v1/team/budgets`, page permission `team.budgets.manage`). Money is in
 * dollars, tokens are input + output + cache tokens; null means no budget.
 */

const usd = z.number().min(0).max(MAX_BUDGET_USD).nullable();
const tokens = z.number().int().min(0).max(MAX_BUDGET_TOKENS).nullable();
const rpm = z.number().int().min(1).max(MAX_REQUESTS_PER_MINUTE).nullable();

const amounts = {
  monthly_usd: usd,
  daily_usd: usd,
  monthly_tokens: tokens,
  daily_tokens: tokens,
};
const amountsSchema = z.strictObject(amounts);
type Amounts = z.infer<typeof amountsSchema>;
const teamBudget = z.strictObject({ ...amounts, user_requests_per_minute: rpm });

const spend = z.object({
  month_usd: z.number(),
  day_usd: z.number(),
  month_tokens: z.number(),
  day_tokens: z.number(),
});
const amountsRow = z.object({
  monthly_usd: z.number().nullable(),
  daily_usd: z.number().nullable(),
  monthly_tokens: z.number().nullable(),
  daily_tokens: z.number().nullable(),
});
const budgetsAnswer = z.object({
  period: z.object({ month: z.string(), day: z.string() }),
  team: amountsRow.extend({
    user_requests_per_minute: z.number().nullable(),
    spent: spend,
    member_default: amountsRow,
  }),
  effective_requests_per_minute: z.number(),
  members: z.array(
    amountsRow.extend({ user_id: z.uuid(), name: z.string().nullable(), spent: spend }),
  ),
  eval_cap: z.object({ usd: z.number().nullable(), tokens: z.number().nullable() }),
});

const spendOut = z.strictObject({
  month_usd: z.number(),
  day_usd: z.number(),
  month_tokens: z.number(),
  day_tokens: z.number(),
});
const amountsOut = z.strictObject({
  monthly_usd: z.number().nullable(),
  daily_usd: z.number().nullable(),
  monthly_tokens: z.number().nullable(),
  daily_tokens: z.number().nullable(),
});

const pick = (a: z.infer<typeof amountsRow>) => ({
  monthly_usd: a.monthly_usd,
  daily_usd: a.daily_usd,
  monthly_tokens: a.monthly_tokens,
  daily_tokens: a.daily_tokens,
});
const spent = (s: z.infer<typeof spend>) => ({
  month_usd: s.month_usd,
  day_usd: s.day_usd,
  month_tokens: s.month_tokens,
  day_tokens: s.day_tokens,
});

export const teamBudgetsGet = kobeTool({
  name: "team_budgets_get",
  title: "Read team budgets",
  description:
    "Reads the conversation's team budget (monthly/daily dollars and tokens, per-user request " +
    "rate), the default member budget, each member's own budget and this period's spend " +
    "(Team console › Budgets). Members are paged: pass next_cursor back as cursor.",
  scope: "team",
  permission: "team.budgets.manage",
  readOnly: true,
  input: z.strictObject({ cursor: cursorSchema.optional() }),
  output: z.strictObject({
    period: z.strictObject({ month: z.string().max(40), day: z.string().max(40) }),
    team: amountsOut.extend({
      user_requests_per_minute: z.number().nullable(),
      spent: spendOut,
    }),
    member_default: amountsOut,
    effective_requests_per_minute: z.number(),
    eval_cap: z.strictObject({ usd: z.number().nullable(), tokens: z.number().nullable() }),
    members: z
      .array(
        amountsOut.extend({
          user_id: z.uuid(),
          name: z.string().max(200).nullable(),
          spent: spendOut,
        }),
      )
      .max(50),
    next_cursor: cursorSchema.optional(),
  }),
  route: () => ({ method: "GET", path: "/team/budgets" }),
  reduce: (body, input) => {
    const b = budgetsAnswer.parse(body);
    const { rows, next_cursor } = page(b.members, input.cursor);
    return {
      period: { month: b.period.month.slice(0, 40), day: b.period.day.slice(0, 40) },
      team: {
        ...pick(b.team),
        user_requests_per_minute: b.team.user_requests_per_minute,
        spent: spent(b.team.spent),
      },
      member_default: pick(b.team.member_default),
      effective_requests_per_minute: b.effective_requests_per_minute,
      eval_cap: { usd: b.eval_cap.usd, tokens: b.eval_cap.tokens },
      members: rows.map((m) => ({
        user_id: m.user_id,
        name: m.name?.slice(0, 200) ?? null,
        ...pick(m),
        spent: spent(m.spent),
      })),
      ...(next_cursor === undefined ? {} : { next_cursor }),
    };
  },
});

async function budgets(call: KobeRouteCaller) {
  const answer = await call({ method: "GET", path: "/team/budgets" });
  if (answer.status !== 200) return undefined;
  const parsed = budgetsAnswer.safeParse(answer.body);
  return parsed.success ? parsed.data : undefined;
}

const cents = (v: number | null) => (v === null ? null : Math.round(v * 100));
const sameAmounts = (a: z.infer<typeof amountsRow>, b: Amounts) =>
  cents(a.monthly_usd) === cents(b.monthly_usd) &&
  cents(a.daily_usd) === cents(b.daily_usd) &&
  a.monthly_tokens === b.monthly_tokens &&
  a.daily_tokens === b.daily_tokens;

const show = (v: Readonly<Record<string, number | null | undefined>>) =>
  Object.entries(v)
    .map(([k, x]) => `${k} ${x === null ? "none" : String(x)}`)
    .join(", ");

const setTeamInput = z.strictObject({
  /** The team's own budget as the person saw it (team_budgets_get › team). */
  from: teamBudget,
  /** Only the fields to change; null removes that budget (or the team's own request rate). */
  to: teamBudget.partial().refine((v) => Object.keys(v).length > 0, "nothing to change"),
});

export const teamBudgetsSetTeam = kobeTool({
  name: "team_budgets_set_team",
  title: "Change the team budget",
  description:
    "Changes the conversation's team budget: monthly/daily dollars or tokens and the per-user " +
    "request rate (Team console › Budgets). Give from exactly as team_budgets_get shows the team, " +
    "and in to only the fields to change. The person is always asked to approve; never retry a " +
    "refused or denied call.",
  scope: "team",
  permission: "team.budgets.manage",
  readOnly: false,
  destructive: false,
  input: setTeamInput,
  output: z.strictObject({ team: teamBudget }),
  route: (input) => ({
    method: "PUT",
    path: "/team/budgets/team",
    body: { ...input.to, expected: input.from },
  }),
  reduce: (body) => {
    const b = budgetsAnswer.parse(body);
    return {
      team: { ...pick(b.team), user_requests_per_minute: b.team.user_requests_per_minute },
    };
  },
  before: async (input, call): Promise<BeforeState> => {
    const b = await budgets(call);
    if (b === undefined) return "changed";
    return sameAmounts(b.team, input.from) &&
      b.team.user_requests_per_minute === input.from.user_requests_per_minute
      ? "same"
      : "changed";
  },
  summary: (input) => `Team budget: ${show(input.to)}`,
});

const setMemberInput = z.strictObject({
  user_id: z.uuid(),
  /** The member's own budget as the person saw it (team_budgets_get › members), or null for none. */
  from: amountsSchema.nullable(),
  /** The member's new budget, or null to remove it (they get the default member budget). */
  to: amountsSchema
    .nullable()
    .refine(
      (v) => v === null || Object.values(v).some((x) => x !== null),
      "set at least one budget, or null to remove it",
    ),
});

export const teamBudgetsSetMember = kobeTool({
  name: "team_budgets_set_member",
  title: "Set or remove a member's budget",
  description:
    "Sets one member's own budget in the conversation's team, or removes it with to: null so the " +
    "default member budget applies (Team console › Budgets). Give from exactly as " +
    "team_budgets_get shows the member, or null when they have none. The person is always asked " +
    "to approve; never retry a refused or denied call.",
  scope: "team",
  permission: "team.budgets.manage",
  readOnly: false,
  destructive: false,
  input: setMemberInput,
  output: z.strictObject({ user_id: z.uuid(), budget: amountsOut.nullable() }),
  route: (input) =>
    input.to === null
      ? {
          method: "DELETE",
          path: `/team/budgets/members/${input.user_id}`,
          ...(input.from === null ? {} : { body: { expected: input.from } }),
        }
      : {
          method: "PUT",
          path: `/team/budgets/members/${input.user_id}`,
          body: { ...input.to, expected: input.from },
        },
  reduce: (body, input) => {
    const row = budgetsAnswer.parse(body).members.find((m) => m.user_id === input.user_id);
    return { user_id: input.user_id, budget: row === undefined ? null : pick(row) };
  },
  before: async (input, call): Promise<BeforeState> => {
    const b = await budgets(call);
    if (b === undefined) return "changed";
    const row = b.members.find((m) => m.user_id === input.user_id);
    if (input.from === null) return row === undefined ? "same" : "changed";
    return row !== undefined && sameAmounts(row, input.from) ? "same" : "changed";
  },
  summary: (input) =>
    input.to === null
      ? `Remove the own budget of member ${input.user_id}`
      : `Budget of member ${input.user_id}: ${show(input.to)}`,
});
