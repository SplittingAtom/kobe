import { Hono } from "hono";
import {
  BRANCH_SUMMARY_ERROR_HTTP_STATUS,
  branchSummaryError,
  branchSummaryRequestSchema,
} from "@kobe/protocol";
import { toProtocolTeamRole } from "../authz/team-role.js";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { BranchSummaryError } from "../runs/branch-summary.js";
import { RunError } from "../runs/errors.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";
import { refuseEvalThreadWrites } from "./eval-thread-guard.js";

const ENTRY_NOT_FOUND = {
  code: "entry_not_found",
  message: "That message is not in this conversation.",
} as const;

/**
 * `POST /v1/threads/{id}/branch-summary` (KOBE-548, CT11): the owner makes `to_entry_id` current
 * and has Pi carry a summary of the branch left into it, optionally with a one-line focus. Shaped
 * like Compact now (`thread-compact.ts`): 200 once the summary is the thread's leaf, else the
 * contract's fixed message per code (the sandbox's text is never relayed). A skill eval's thread
 * answers the guard's `skill_eval_thread`; builder test and Workbench threads `test_thread`.
 */
export function threadBranchSummaryRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.use("/:id/branch-summary", refuseEvalThreadWrites(deps, "thread"));

  app.post("/:id/branch-summary", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    const body = await parseBody(c, branchSummaryRequestSchema);
    if (!id.success || !body) {
      return invalidRequest(c, "Give the entry to switch to and an optional one-line focus.");
    }
    const team = c.get("team");
    try {
      const result = await deps.runs.branchSummary(
        {
          user_id: c.get("user").id,
          team_id: team.id,
          site_role: c.get("siteRole") ?? "user",
          team_role: toProtocolTeamRole(team.role),
        },
        id.data,
        body.to_entry_id,
        body.focus,
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof BranchSummaryError) {
        if (err.code === "entry_not_found") return c.json(ENTRY_NOT_FOUND, 404);
        return c.json(branchSummaryError(err.code), BRANCH_SUMMARY_ERROR_HTTP_STATUS[err.code]);
      }
      // A shared reader (`lockOwnedThread`): the contract's own read_only message.
      if (err instanceof RunError && err.code === "read_only") {
        return c.json(branchSummaryError("read_only"), BRANCH_SUMMARY_ERROR_HTTP_STATUS.read_only);
      }
      // A thread row held past the lock timeout: the contract's own busy answer.
      if (err instanceof RunError && err.code === "thread_busy") {
        return c.json(
          branchSummaryError("thread_busy"),
          BRANCH_SUMMARY_ERROR_HTTP_STATUS.thread_busy,
        );
      }
      if (err instanceof RunError) {
        return c.json({ code: err.code, message: err.message }, err.status as 400);
      }
      throw err;
    }
  });

  return app;
}
