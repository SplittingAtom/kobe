import { sql, withTeam } from "@kobe/db";
import { createMiddleware } from "hono/factory";
import type { TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";

// Skill eval threads (KOBE-325) are run by the eval runner only: no member sends a message,
// steers, retries, cancels, forks, shares, moves or edits one (the eval would no longer measure
// the skill). Reading stays as for any thread of its owner.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REFUSAL = {
  code: "skill_eval_thread",
  message: "This is a skill eval's thread: the eval runs it. Start a new chat instead.",
} as const;

/** Refuses every write to the `:id` thread (or the `:id` run's thread) when it is an eval's. */
export function refuseEvalThreadWrites(deps: ServerDeps, idIs: "thread" | "run") {
  return createMiddleware<{ Variables: TeamVariables }>(async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();
    const id = c.req.param("id");
    const team = c.get("team");
    if (!id || !UUID.test(id) || !team) return next();
    const res = await withTeam(deps.database.db, team.id, (tx) =>
      tx.execute<{ skill_eval: boolean }>(
        idIs === "thread"
          ? sql`SELECT skill_eval FROM threads WHERE team_id = ${team.id} AND id = ${id}`
          : sql`SELECT t.skill_eval FROM runs r
                  JOIN threads t ON t.team_id = r.team_id AND t.id = r.thread_id
                 WHERE r.team_id = ${team.id} AND r.id = ${id} AND t.team_id = ${team.id}`,
      ),
    );
    if (res.rows[0]?.skill_eval === true) return c.json(REFUSAL, 409);
    return next();
  });
}
