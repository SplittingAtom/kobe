import { Hono, type Context } from "hono";
import { withTeam } from "@kobe/db";
import {
  LEARN_REFUSAL_HTTP_STATUS,
  learnStartRequestSchema,
  type LearnRefusal,
  type LearnStartResponse,
} from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { readLearnState } from "../memory/learn/state.js";
import { viewerProjectIds } from "../threads/references.js";
import type { Viewer } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";
import { invalidRequest, param, parseBody } from "../http/request.js";

const NOT_FOUND: LearnRefusal = { code: "thread_not_found", message: "Thread not found." };
const READ_ONLY: LearnRefusal = {
  code: "read_only",
  message: "Only the thread's author can teach Kobe from it.",
};

const refusal = (c: Context, r: LearnRefusal) => c.json(r, LEARN_REFUSAL_HTTP_STATUS[r.code]);

/**
 * Learn from this chat (KOBE-395; SM12, Q8), for the composer's + menu, `/learn`, `/learn all`,
 * Mod+Shift+L and the palette:
 *
 * - `GET /v1/threads/{id}/learn[?estimate=1]`: the thread's Learn state (`learnStateSchema`):
 *   why a pass can't start, a running pass, the dot (new messages since the last pass) and the
 *   open candidates from this chat; with `estimate=1` also the token estimates for the tooltip.
 * - `POST /v1/threads/{id}/learn` `{mode: "new" | "all"}`: starts a pass (202) or answers the
 *   refusal with its code and message (`LEARN_REFUSAL_HTTP_STATUS`).
 *
 * Owner only: a reader of a shared thread gets 403 `read_only`, anyone else 404.
 */
export function threadLearnRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const db = deps.database.db;
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  const viewerOf = async (c: Context<{ Variables: TeamVariables }>): Promise<Viewer> => {
    const teamId = c.get("team").id;
    const userId = c.get("user").id;
    const projectIds = await withTeam(db, teamId, (tx) => viewerProjectIds(tx, teamId, userId));
    return { teamId, userId, projectIds };
  };

  app.get("/:id/learn", async (c) => {
    const id = param(c, "id", uuidSchema);
    if (!id.success) return invalidRequest(c, "The thread id is not a uuid.");
    const result = await readLearnState(db, await viewerOf(c), id.data, {
      serverCalls: deps.learningPasses.serverCalls,
      estimate: c.req.query("estimate") === "1",
    });
    if (!result.ok) return refusal(c, result.code === "read_only" ? READ_ONLY : NOT_FOUND);
    return c.json(result.state);
  });

  app.post("/:id/learn", async (c) => {
    const id = param(c, "id", uuidSchema);
    const body = await parseBody(c, learnStartRequestSchema);
    if (!id.success || !body) return invalidRequest(c, 'Send {"mode": "new"} or {"mode": "all"}.');
    const started = await deps.learningPasses.start(await viewerOf(c), id.data, {
      rescan: body.mode === "all",
      ...(body.viewed_leaf_entry_id === undefined
        ? {}
        : { viewedLeafEntryId: body.viewed_leaf_entry_id }),
    });
    if (!started.ok) {
      const {
        ok: _ok,
        leafEntryId,
        ...rest
      } = started as typeof started & {
        leafEntryId?: string;
      };
      return refusal(c, {
        ...rest,
        ...(leafEntryId === undefined ? {} : { leaf_entry_id: leafEntryId }),
      } as LearnRefusal);
    }
    const out: LearnStartResponse = {
      pass_id: started.passId,
      run_id: started.runId,
      model_alias: started.modelAlias,
      mode: body.mode,
      input: {
        entries: started.input.entries,
        truncated: started.input.truncated,
        summarised: started.input.summarised,
        partial: started.input.partial,
        estimated_tokens: started.input.estimatedTokens,
      },
    };
    return c.json(out, 202);
  });

  return app;
}
