import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { launchAppCardBodySchema, type LaunchAppCardResponse } from "@kobe/protocol";
import {
  APP_LAUNCH_RATE,
  launchAppCard,
  removeQueuedAppCard,
  type LaunchOutcome,
} from "../apps/app-cards.js";
import { createRateLimiter } from "../sandbox/rate-limit.js";
import { RUN_DEFAULTS } from "../runs/orchestrator.js";
import type { BrowserPrincipal } from "../apps/call.js";
import { appCallDepsFor } from "../apps/call-deps.js";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { uuidSchema } from "../threads/schemas.js";

/**
 * Rail launches (KOBE-440, spec MA11, §6), under the browser principal (the member and the active
 * team, `team.chat`):
 *
 * - `POST /v1/threads/{id}/app-cards {app_id}`: calls the app's opening tool as the member and
 *   inserts an app card at the thread's leaf (201 `{thread_id, entry_id, result_ref, queued:
 *   false}`), or, during an active run, queues it (201 `{thread_id, result_ref, queued: true}`).
 * - `POST /v1/threads/app-cards {app_id}`: the same into a new thread titled after the app.
 * - `DELETE /v1/threads/{id}/app-cards/{ref}`: removes a waiting card (204), else 404.
 */
const BODY_MAX = 1024;

const principal = (c: Context<{ Variables: TeamVariables }>): BrowserPrincipal => ({
  kind: "browser",
  userId: c.get("user").id,
  teamId: c.get("team").id,
});

function answer(c: Context, outcome: LaunchOutcome) {
  if (!outcome.ok) return c.json({ code: outcome.code, message: outcome.message }, outcome.status);
  const body: LaunchAppCardResponse =
    outcome.entryId === undefined || outcome.queued
      ? { thread_id: outcome.threadId, result_ref: outcome.resultRef, queued: true }
      : {
          thread_id: outcome.threadId,
          entry_id: outcome.entryId,
          result_ref: outcome.resultRef,
          queued: false,
        };
  return c.json(body, 201);
}

export function threadAppCardRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  const cardDeps = {
    call: appCallDepsFor(deps),
    store: deps.appResults.store,
    launches: createRateLimiter(APP_LAUNCH_RATE),
    abortHoldMs: () => deps.runs.abortHoldMs ?? RUN_DEFAULTS.stopGraceMs,
  };
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  const limit = bodyLimit({
    maxSize: BODY_MAX,
    onError: (c) => c.json({ code: "too_large", message: "The request is too large." }, 413),
  });
  app.use("/app-cards", limit);
  app.use("/:id/app-cards", limit);

  app.post("/app-cards", async (c) => {
    const body = await parseBody(c, launchAppCardBodySchema);
    if (!body) return invalidRequest(c, "Send {app_id}.");
    return answer(c, await launchAppCard(cardDeps, principal(c), null, body.app_id));
  });

  app.post("/:id/app-cards", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    const body = await parseBody(c, launchAppCardBodySchema);
    if (!id.success || !body) return invalidRequest(c, "Send {app_id}.");
    return answer(c, await launchAppCard(cardDeps, principal(c), id.data, body.app_id));
  });

  app.delete("/:id/app-cards/:ref", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    const ref = uuidSchema.safeParse(c.req.param("ref"));
    if (!id.success || !ref.success) return invalidRequest(c);
    const removed = await removeQueuedAppCard(cardDeps, principal(c), id.data, ref.data);
    return removed
      ? c.body(null, 204)
      : c.json({ code: "not_found", message: "No waiting app card with that id." }, 404);
  });

  return app;
}
