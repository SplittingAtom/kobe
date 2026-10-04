import { exhaustedLine, loadMemberBudgetState } from "@kobe/db";
import type { RunBudgetGate } from "../runs/seams.js";

/**
 * D30 "new runs are blocked" (KOBE-42): a member may start a run only while no budget that applies
 * to them (install, team, their own) is used up. Read in the run-start transaction (the team's RLS
 * context), from the same daily spend counters the model gateway's call gate reads.
 */
export const DB_RUN_BUDGET_GATE: RunBudgetGate = {
  async allowsNewRun(tx, { teamId, userId }) {
    const state = await loadMemberBudgetState(tx, teamId, userId);
    return exhaustedLine(state.lines) === undefined;
  },
};
