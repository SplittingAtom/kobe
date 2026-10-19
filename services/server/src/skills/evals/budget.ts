import {
  exhaustedLine,
  sql,
  loadMemberBudgetState,
  withTeam,
  type BudgetLine,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";

// Skill evals and budgets (KOBE-327, D30, SK18). Eval spend counts against every budget like
// any run's (kinds `eval` and `eval_judge`), and the optional team eval cap counts eval spend
// only. Enforcement is the model gateway's: each eval call is reserved through
// `kobe_reserve_budget` with the member's lines and the cap's (atomic across replicas). This
// module is the eval side's reading of the same numbers: a new eval is refused, and a running one
// ends `budget_stopped`, once a line that applies is used up, with a message saying which.

export type EvalBudgetCode = "eval_cap_reached" | "budget_exhausted";

export interface EvalBudgetBlock {
  readonly code: EvalBudgetCode;
  readonly message: string;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const amount = (line: BudgetLine, n: number) =>
  line.unit === "usd" ? money(n) : `${Math.round(n).toLocaleString("en-US")} tokens`;

const BUDGET_NAMES: Readonly<Record<"site" | "team" | "user", string>> = {
  site: "The site's",
  team: "Your team's",
  user: "Your",
};

/** Why `line` stops evals, in words for the member. */
export function evalBudgetMessage(line: BudgetLine): EvalBudgetBlock {
  if (line.scope === "eval")
    return {
      code: "eval_cap_reached",
      message: `Your team's monthly eval cap (${amount(line, line.limit)}) is used up. A Team admin can raise or remove it.`,
    };
  const period = line.period === "month" ? "monthly" : "daily";
  const kind = line.unit === "tokens" ? "token" : "model";
  return {
    code: "budget_exhausted",
    message: `${BUDGET_NAMES[line.scope]} ${period} ${kind} budget is used up, so evals can't run until it resets or an admin raises it.`,
  };
}

/**
 * Run failure codes of a gateway budget refusal (sandbox-agent `kobe-models/errors.ts`): a used-up
 * budget or eval cap (spend plus the calls in flight), or a request larger than one.
 */
export const BUDGET_FAILURES: ReadonlySet<string> = new Set([
  "model_budget_exhausted",
  "model_budget_too_small",
]);

/** The judge's server call refused for the same reasons (the gateway's codes). */
export const JUDGE_BUDGET_CODES: ReadonlySet<string> = new Set([
  "budget_exhausted",
  "budget_below_call",
  "budget_soft_limit",
]);

/** When the gateway refused a call but no line reads as used up any more (its calls settled). */
export const REFUSED_BLOCK: EvalBudgetBlock = {
  code: "budget_exhausted",
  message:
    "A budget or the team eval cap refused this eval's model calls (it was used up with the calls in flight), so the eval stopped. Try again once it resets or an admin raises it.",
};

/** What the team's (and the member's) live reservations hold: spend still in flight. */
async function heldIn(tx: KobeTx, teamId: string, userId: string) {
  const res = await tx.execute<Record<string, unknown>>(sql`
    SELECT COALESCE(sum(usd), 0) AS team_usd, COALESCE(sum(tokens), 0) AS team_tokens,
           COALESCE(sum(usd) FILTER (WHERE user_id = ${userId}::uuid), 0) AS user_usd,
           COALESCE(sum(tokens) FILTER (WHERE user_id = ${userId}::uuid), 0) AS user_tokens,
           COALESCE(sum(usd) FILTER (WHERE eval), 0) AS eval_usd,
           COALESCE(sum(tokens) FILTER (WHERE eval), 0) AS eval_tokens
      FROM budget_reservations
     WHERE team_id = ${teamId}::uuid AND expires_at > clock_timestamp()`);
  const r = res.rows[0] ?? {};
  return (scope: BudgetLine["scope"], unit: BudgetLine["unit"]) =>
    scope === "site" ? 0 : Number(r[`${scope}_${unit}`] ?? 0);
}

/**
 * The budget or eval cap that stops the starter's evals now, or null (inside `withTeam`). With
 * `inFlight` (after the gateway refused a call), a line also counts as used up when its spend
 * plus the live reservations reach it: the gateway's own rule (review-327 M1).
 */
export async function evalBudgetBlockIn(
  tx: KobeTx,
  teamId: string,
  userId: string,
  options: { readonly inFlight?: boolean } = {},
): Promise<EvalBudgetBlock | null> {
  const state = await loadMemberBudgetState(tx, teamId, userId);
  const used = exhaustedLine(state.lines) ?? exhaustedLine(state.evalLines ?? []);
  if (used) return evalBudgetMessage(used);
  if (!options.inFlight) return null;
  const held = await heldIn(tx, teamId, userId);
  const lines = [...(state.evalLines ?? []), ...state.lines];
  const reached = lines.find((l) => l.spent + held(l.scope, l.unit) >= l.limit);
  return reached ? evalBudgetMessage(reached) : null;
}

export function evalBudgetBlock(
  db: KobeDb,
  teamId: string,
  userId: string,
  options: { readonly inFlight?: boolean } = {},
): Promise<EvalBudgetBlock | null> {
  return withTeam(db, teamId, (tx) => evalBudgetBlockIn(tx, teamId, userId, options));
}
