import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  FEEDBACK_ERROR_HTTP_STATUS,
  putFeedbackBodySchema,
  type FeedbackErrorCode,
} from "@kobe/protocol";
import { withTeam, type KobeTx } from "@kobe/db";
import { requireTeam, requireTeamPermission, type TeamVariables } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import {
  clearRating,
  rateAnswer,
  threadFeedback,
  toAnswerFeedback,
  type FeedbackError,
} from "../feedback/store.js";
import { parseBody } from "../teams/http.js";
import { viewerProjectIds } from "../threads/references.js";
import type { Viewer } from "../threads/repository.js";
import { uuidSchema } from "../threads/schemas.js";

type Ctx = Context<{ Variables: TeamVariables }>;

/** Largest feedback body (a 500-character comment, five reasons and an entry id fit easily). */
const FEEDBACK_MAX_BODY = 8 * 1024;

const MESSAGES = {
  invalid_request:
    "Rate with up or down; reasons and a comment of up to 500 characters go with down.",
  run_not_found: "No answer with that id.",
  thread_not_found: "No thread with that id.",
  entry_not_found: "That entry is not part of this conversation.",
  agent_not_found: "No agent with that id is available in this team.",
  forbidden: "Only the agent's owners and team admins see its ratings.",
  run_not_ended: "Wait for the answer to finish before rating it.",
  not_an_answer: "Only answers can be rated.",
  thread_in_trash: "The conversation is in Trash. Restore it first.",
  test_thread: "Test conversations aren't rated.",
} as const satisfies Record<FeedbackErrorCode, string>;

export function feedbackError(c: Context, code: FeedbackErrorCode | FeedbackError) {
  return c.json({ code, message: MESSAGES[code] }, FEEDBACK_ERROR_HTTP_STATUS[code]);
}

async function asViewer<T>(
  deps: ServerDeps,
  c: Ctx,
  fn: (tx: KobeTx, viewer: Viewer) => Promise<T>,
): Promise<T> {
  const teamId = c.get("team").id;
  const userId = c.get("user").id;
  return withTeam(deps.database.db, teamId, async (tx) =>
    fn(tx, { teamId, userId, projectIds: await viewerProjectIds(tx, teamId, userId) }),
  );
}

/**
 * Rating an answer (KOBE-275): `PUT` / `DELETE /v1/runs/{id}/feedback`, mounted on `/v1/runs`.
 * Members with `team.chat` who can read the run's thread rate it for themselves. Under a legal
 * hold a change or clear answers exactly as without one (the database keeps the old row aside,
 * migration `*_answer_feedback_hold.sql`): a hold is never revealed. Rating changes are not audited (one row per click would be noise, and the row holds what changed). With a
 * Langfuse tracing backend the rating is exported as a score on the run's trace after commit.
 */
export function runFeedbackRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));

  app.put(
    "/:id/feedback",
    bodyLimit({
      maxSize: FEEDBACK_MAX_BODY,
      onError: (c) => feedbackError(c, "invalid_request"),
    }),
    async (c) => {
      const id = uuidSchema.safeParse(c.req.param("id"));
      if (!id.success) return feedbackError(c, "run_not_found");
      const body = await parseBody(c, putFeedbackBodySchema);
      if (!body) return feedbackError(c, "invalid_request");
      const result = await asViewer(deps, c, (tx, viewer) => rateAnswer(tx, viewer, id.data, body));
      if (!result.ok) return feedbackError(c, result.error);
      deps.feedbackScores?.enqueue(c.get("team").id, result.value.id);
      return c.json(toAnswerFeedback(result.value));
    },
  );

  app.delete("/:id/feedback", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return feedbackError(c, "run_not_found");
    const cleared = await asViewer(deps, c, (tx, viewer) => clearRating(tx, viewer, id.data));
    if (cleared !== null) deps.feedbackScores?.enqueue(c.get("team").id, cleared);
    return c.body(null, 204);
  });

  return app;
}

/** `GET /v1/threads/{id}/feedback`: the thread's rateable answers and the caller's ratings. */
export function threadFeedbackRoutes(deps: ServerDeps): Hono<{ Variables: TeamVariables }> {
  const app = new Hono<{ Variables: TeamVariables }>();
  app.use(requireTeam(deps));
  app.use(requireTeamPermission("team.chat"));
  app.get("/:id/feedback", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return feedbackError(c, "thread_not_found");
    const result = await asViewer(deps, c, (tx, viewer) => threadFeedback(tx, viewer, id.data));
    if (!result.ok) return feedbackError(c, result.error);
    return c.json(result.value);
  });
  return app;
}
