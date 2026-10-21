import { Hono, type Context } from "hono";
import { notebookRunBodySchema, type ActorContext } from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { NOTEBOOK_ERROR_STATUS, NotebookRunError } from "../notebooks/user-run.js";
import { RunError } from "../runs/errors.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";
import { refuseEvalThreadWrites } from "./eval-thread-guard.js";

type Ctx = Context<{ Variables: TeamVariables }>;

/**
 * The thread's notebook kernel (KOBE-464, contract `notebooks.ts`, docs/specs/notebooks.md):
 * - `POST /v1/threads/{id}/notebook/run` {path, cell_id?, timeout_s?}: 202 {run_id, exec_id}; the
 *   outputs stream on `GET /v1/runs/{run_id}/events` and a cell's are saved into its notebook;
 * - `POST /v1/threads/{id}/notebook/interrupt` and `.../restart`: 200 {status}.
 * The thread's owner only (the kernel is in their sandbox); a shared reader is 403 `read_only`,
 * another member's or team's thread 404. Eval threads are refused like every other write.
 */
export function threadNotebookRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.use("/:id/*", refuseEvalThreadWrites(deps, "thread"));

  app.post("/:id/notebook/run", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    const body = await parseBody(c, notebookRunBodySchema);
    if (!id.success || !body) {
      return invalidRequest(c, "Name an .ipynb file with a cell_id, or a .py file.");
    }
    return answer(c, async () =>
      c.json(await deps.runs.notebookRun(actorOf(c), id.data, body), 202),
    );
  });

  for (const op of ["interrupt", "restart"] as const) {
    app.post(`/:id/notebook/${op}`, async (c) => {
      const id = uuidSchema.safeParse(c.req.param("id"));
      if (!id.success) return invalidRequest(c, "Unknown conversation.");
      return answer(c, async () => c.json(await deps.runs.notebookKernel(actorOf(c), id.data, op)));
    });
  }

  return app;
}

function actorOf(c: Ctx): ActorContext {
  const team = c.get("team");
  return {
    user_id: c.get("user").id,
    team_id: team.id,
    site_role: c.get("siteRole") ?? "user",
    team_role: team.role,
  };
}

async function answer(c: Ctx, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotebookRunError) {
      return c.json(
        { code: err.code, message: err.message },
        NOTEBOOK_ERROR_STATUS[err.code] as 400,
      );
    }
    if (err instanceof RunError) {
      return c.json({ code: err.code, message: err.message }, err.status as 400);
    }
    throw err;
  }
}
