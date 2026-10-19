import {
  exhaustedLine,
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
      message: `Your team's monthly eval cap (${amount(line, line.limit)}) is used up: ${amount(line, line.spent)} spent on evals this month. A Team admin can raise or remove it.`,
    };
  const period = line.period === "month" ? "monthly" : "daily";
  const kind = line.unit === "tokens" ? "token" : "model";
  return {
    code: "budget_exhausted",
    message: `${BUDGET_NAMES[line.scope]} ${period} ${kind} budget is used up, so evals can't run until it resets or an admin raises it.`,
  };
}

/** The budget or eval cap that stops the starter's evals now, or null (inside `withTeam`). */
export async function evalBudgetBlockIn(
  tx: KobeTx,
  teamId: string,
  userId: string,
): Promise<EvalBudgetBlock | null> {
  const state = await loadMemberBudgetState(tx, teamId, userId);
  const used = exhaustedLine(state.lines) ?? exhaustedLine(state.evalLines ?? []);
  return used ? evalBudgetMessage(used) : null;
}

export function evalBudgetBlock(
  db: KobeDb,
  teamId: string,
  userId: string,
): Promise<EvalBudgetBlock | null> {
  return withTeam(db, teamId, (tx) => evalBudgetBlockIn(tx, teamId, userId));
}
