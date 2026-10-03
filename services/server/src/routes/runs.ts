import type { Context } from "hono";
import { Hono } from "hono";
import type { z } from "zod";
import {
  steerBodySchema,
  submitMessageBodySchema,
  updateQueuedBodySchema,
  type ActorContext,
} from "@kobe/protocol";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { RunError } from "../runs/errors.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";

type RunContext = Context<{ Variables: TeamVariables }>;

/** The verified caller (session + active team), never taken from the request body. */
function actorOf(c: RunContext): ActorContext {
  const team = c.get("team");
  return {
    user_id: c.get("user").id,
    team_id: team.id,
    install_role: c.get("installRole") ?? "user",
    team_role: team.role,
  };
}

function idParam(c: Context): string | undefined {
  const parsed = uuidSchema.safeParse(c.req.param("id"));
  return parsed.success ? parsed.data : undefined;
}

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T | undefined> {
  return parseBody(c, schema);
}

/** Runs an orchestrator call; its `RunError`s become `{code, message}` with their status. */
async function answer(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RunError) {
      return c.json({ code: err.code, message: err.message }, err.status as 400);
    }
    throw err;
  }
}

function scoped(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  return app;
}

/**
 * Messages and the thread's run queue (spec §6.1 `POST /v1/threads/{id}/messages`, D17), mounted
 * under `/v1/threads`. Team-scoped like the Thread API; only the thread's owner posts (D23: a
 * project reader is read-only).
 */
export function threadRunRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = scoped(deps);

  app.post("/:id/messages", async (c) => {
    const id = idParam(c);
    const parsed = await body(c, submitMessageBodySchema);
    if (!id || !parsed) return invalidRequest(c, "Give content (and parent_entry_id, file_ids).");
    return answer(c, async () =>
      c.json(
        await deps.runs.submitMessage(actorOf(c), { ...parsed, thread_id: id, trigger: "user" }),
        201,
      ),
    );
  });

  app.get("/:id/runs", async (c) => {
    const id = idParam(c);
    if (!id) return invalidRequest(c);
    return answer(c, async () => c.json({ runs: await deps.runs.listThreadRuns(actorOf(c), id) }));
  });

  app.post("/:id/queue/resume", async (c) => {
    const id = idParam(c);
    if (!id) return invalidRequest(c);
    return answer(c, async () => {
      await deps.runs.resumeQueue(actorOf(c), id);
      return c.json({ runs: await deps.runs.listThreadRuns(actorOf(c), id) });
    });
  });

  return app;
}

/**
 * Runs (spec §6.1 `/v1/runs/{id}/steer|cancel|retry`, D14, D17): status, edit a queued message,
 * Steer, Stop (also deletes a queued message) and Retry. Mounted under `/v1/runs` next to the event
 * stream (`run-events.ts`).
 */
export function runRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = scoped(deps);

  app.get("/:id", async (c) => {
    const id = idParam(c);
    if (!id) return invalidRequest(c);
    return answer(c, async () => c.json(await deps.runs.getRun(actorOf(c), id)));
  });

  app.patch("/:id", async (c) => {
    const id = idParam(c);
    const parsed = await body(c, updateQueuedBodySchema);
    if (!id || !parsed) return invalidRequest(c, "Give the new content.");
    return answer(c, async () => c.json(await deps.runs.updateQueued(actorOf(c), id, parsed)));
  });

  app.post("/:id/steer", async (c) => {
    const id = idParam(c);
    const parsed = await body(c, steerBodySchema);
    if (!id || !parsed) return invalidRequest(c, "Give content.");
    return answer(c, async () => c.json(await deps.runs.steer(actorOf(c), id, parsed)));
  });

  app.post("/:id/cancel", async (c) => {
    const id = idParam(c);
    if (!id) return invalidRequest(c);
    return answer(c, async () => c.json(await deps.runs.cancel(actorOf(c), id)));
  });

  app.post("/:id/retry", async (c) => {
    const id = idParam(c);
    if (!id) return invalidRequest(c);
    return answer(c, async () => c.json(await deps.runs.retry(actorOf(c), id), 201));
  });

  return app;
}
