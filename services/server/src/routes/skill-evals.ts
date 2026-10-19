import { Hono, type Context } from "hono";
import { z } from "zod";
import { withTeam } from "@kobe/db";
import { startSkillEvalBodySchema } from "@kobe/protocol";
import { requireTeam, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { logger } from "../logger.js";
import { skillEvalEventStream, type SkillEvalHub } from "../skills/evals/events.js";
import { startSkillEval, type StartSubject } from "../skills/evals/start.js";
import { cancelEvalRun } from "../skills/evals/store.js";
import {
  evalStreamAccess,
  listEvalRuns,
  mayCancel,
  readEvalRun,
  type EvalViewer,
} from "../skills/evals/views.js";

// Skill evals (KOBE-325; contract `@kobe/protocol` skill-evals `api.ts`), in the caller's active
// team: start one for a draft's current revision or a saved version, read it, its history, cancel
// it, and follow it (SSE `skill.eval.progress` / `skill.eval.completed`). Mounted at `/v1` with
// full paths, so each route takes the team middleware itself.

export interface SkillEvalRouteOptions {
  readonly hub?: SkillEvalHub;
  /** Asks this replica's runner to claim work now (it also sweeps on a timer). */
  readonly kick?: () => void;
}

type Ctx = Context<{ Variables: TeamVariables }>;

const uuid = z.uuid();
const seq = z.coerce.number().int().min(1).max(1_000_000);

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
} as const;

const viewerOf = (c: Ctx): EvalViewer => ({
  teamId: c.get("team").id,
  userId: c.get("user").id,
  role: c.get("team").role,
});

const error = (c: Ctx, status: 400 | 403 | 404 | 409 | 422 | 503, code: string, message: string) =>
  c.json({ code, message }, status);

export function skillEvalRoutes(
  deps: ServerDeps,
  options: SkillEvalRouteOptions = {},
): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const team = requireTeam(deps);
  const db = deps.database.db;

  const start = async (c: Ctx, subject: StartSubject) => {
    if (!deps.blobs)
      return error(c, 503, "storage_unavailable", "Object storage is not configured.");
    const body = startSkillEvalBodySchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return error(c, 400, "invalid_request", "Give mode: full or with_only.");
    const started = await startSkillEval(
      { db, blobs: deps.blobs },
      viewerOf(c),
      subject,
      body.data.mode,
    );
    if (!started.ok) {
      const { status, code, message, issues } = started.refusal;
      return c.json({ code, message, ...(issues ? { issues } : {}) }, status);
    }
    logger.info(
      { team_id: c.get("team").id, eval_run_id: started.value.evalRunId },
      "skill eval started",
    );
    options.kick?.();
    return c.json(started.value, 202);
  };

  app.post("/skills/drafts/:id/evals", team, async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return error(c, 404, "skill_not_found", "No such draft.");
    return start(c, { kind: "draft", draftId: id.data });
  });

  app.post("/skills/:scope/:id/versions/:seq/evals", team, async (c) => {
    const scope = c.req.param("scope");
    const id = uuid.safeParse(c.req.param("id"));
    const n = seq.safeParse(c.req.param("seq"));
    if ((scope !== "team" && scope !== "personal") || !id.success || !n.success)
      return error(c, 404, "skill_not_found", "No such skill version.");
    return start(c, { kind: "version", scope, skillId: id.data, seq: n.data });
  });

  app.get("/skill-evals", team, async (c) => {
    const draftId = uuid.safeParse(c.req.query("draft_id"));
    const skillId = uuid.safeParse(c.req.query("skill_id"));
    const scope = c.req.query("scope");
    const subject = draftId.success
      ? { kind: "draft" as const, id: draftId.data }
      : skillId.success && (scope === "team" || scope === "personal")
        ? { kind: scope as "team" | "personal", id: skillId.data }
        : null;
    if (!subject) return error(c, 400, "invalid_request", "Give draft_id, or scope and skill_id.");
    const runs = await withTeam(db, c.get("team").id, (tx) =>
      listEvalRuns(tx, viewerOf(c), subject),
    );
    return c.json({ evals: runs });
  });

  app.get("/skill-evals/:id", team, async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return error(c, 404, "not_found", "No such eval.");
    const run = await withTeam(db, c.get("team").id, (tx) => readEvalRun(tx, viewerOf(c), id.data));
    return run ? c.json(run) : error(c, 404, "not_found", "No such eval.");
  });

  app.post("/skill-evals/:id/cancel", team, async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return error(c, 404, "not_found", "No such eval.");
    const who = viewerOf(c);
    const outcome = await withTeam(db, who.teamId, async (tx) => {
      const run = await readEvalRun(tx, who, id.data);
      if (!run) return "not_found" as const;
      if (!mayCancel(who, run)) return "forbidden" as const;
      return (await cancelEvalRun(tx, who.teamId, id.data))
        ? ("cancelled" as const)
        : ("ended" as const);
    });
    if (outcome === "not_found") return error(c, 404, "not_found", "No such eval.");
    if (outcome === "forbidden")
      return error(c, 403, "forbidden", "Only its starter or a team admin can cancel it.");
    if (outcome === "ended") return error(c, 409, "eval_ended", "The eval has already ended.");
    const run = await withTeam(db, who.teamId, (tx) => readEvalRun(tx, who, id.data));
    // The contract's 202: the cancel is accepted; running executions stop within seconds.
    return c.json(run, 202);
  });

  app.get("/skill-evals/:id/events", team, async (c) => {
    const id = uuid.safeParse(c.req.param("id"));
    if (!id.success) return error(c, 404, "not_found", "No such eval.");
    const who = viewerOf(c);
    const stream = await skillEvalEventStream({ db, hub: options.hub }, who, id.data, {
      reconnect: c.req.header("last-event-id") !== undefined,
      stillAllowed: () =>
        evalStreamAccess(db, {
          teamId: who.teamId,
          userId: who.userId,
          sessionId: c.get("sessionId"),
        }),
    });
    if (stream === "not_found") return error(c, 404, "not_found", "No such eval.");
    // A finished eval's reconnect: 204 tells EventSource to stop (review L5).
    if (stream === "finished") return c.body(null, 204);
    if (stream === "too_many_streams")
      return c.json({ code: "too_many_streams", message: "Too many eval streams open." }, 429);
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  });

  return app;
}
