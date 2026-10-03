import { z } from "zod";
import {
  runSnapshotSchema,
  steerBodySchema,
  submitMessageBodySchema,
  submitMessageResultSchema,
  updateQueuedBodySchema,
} from "@kobe/protocol";

/**
 * OpenAPI 3.1 description of messages and runs (spec §6.1, KOBE-30), generated from the zod
 * schemas the routes validate with (`@kobe/protocol` run contract). `document.test.ts` checks that
 * every mounted route is described.
 */

type JsonSchema = Record<string, unknown>;

const input = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) as JsonSchema;
const output = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { io: "output", target: "draft-2020-12" }) as JsonSchema;
const withoutDialect = ({ $schema: _ignored, ...rest }: JsonSchema): JsonSchema => rest;

/** The thread's active run (if any), then its queued runs in start order. */
export const threadRunsSchema = z.strictObject({ runs: z.array(runSnapshotSchema) });

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schemaName: string, description: string) => ({
  description,
  content: { "application/json": { schema: ref(schemaName) } },
});
const body = (schemaName: string) => ({
  required: true,
  content: { "application/json": { schema: ref(schemaName) } },
});

const idParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;
const teamHeader = {
  name: "X-Kobe-Team",
  in: "header",
  required: false,
  description: "The team the client believes is active. Required on changes; must match.",
  schema: { type: "string", format: "uuid" },
} as const;
const read = [idParameter, teamHeader];
const change = [idParameter, { ...teamHeader, required: true }];

const COMMON = {
  "400": json("Error", "`invalid_request` or `team_header_required`."),
  "401": json("Error", "`unauthenticated`: no session."),
  "403": json(
    "Error",
    "`not_a_team_member`, `forbidden` (team role, or a deactivated account), or `read_only` " +
      "(a project reader of a shared thread).",
  ),
} as const;

const runNotFound = json(
  "Error",
  "`run_not_found`: unknown id, or a run of another team's or another user's thread.",
);
const conflict = (what: string) => json("Error", `${what} \`thread_busy\`: try again.`);

export function runsOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/threads/{id}/messages": {
      post: {
        operationId: "submitMessage",
        summary: "Send a message: starts a run, or queues it behind the thread's active run (D17)",
        description:
          "Owner only. The run is created queued and starts at once when nothing is active and the " +
          "thread is not interrupted; otherwise `queued` is true and it starts in order (Retry " +
          "runs first). Follow it with `GET /v1/runs/{id}/events`. `parent_entry_id` branches " +
          "from an entry (edit-and-regenerate); absent = the thread's leaf when the run starts.",
        parameters: change,
        requestBody: body("SubmitMessageBody"),
        responses: {
          "201": json("SubmitMessageResult", "The run, and whether it waits in the queue."),
          "404": json("Error", "`thread_not_found` or `entry_not_found`."),
          "409": conflict("`thread_in_trash`, `queue_full`, `no_active_team`, `team_mismatch`, or"),
          "422": json("Error", "`attachments_unavailable`: file_ids before uploads exist."),
          "429": json("Error", "`budget_exhausted`: no new runs at 100 % of a budget (D30)."),
          "503": json("Error", "`isolation_unavailable`: agents are disabled (D4)."),
          ...COMMON,
        },
      },
    },
    "/v1/threads/{id}/runs": {
      get: {
        operationId: "listThreadRuns",
        summary: "The thread's active run and its queued runs, in start order",
        parameters: read,
        responses: {
          "200": json("ThreadRuns", "Active run first, then the queue (`queue_pos` 1 = next)."),
          "404": json("Error", "`thread_not_found`."),
          ...COMMON,
        },
      },
    },
    "/v1/threads/{id}/queue/resume": {
      post: {
        operationId: "resumeThreadQueue",
        summary: "Continue without retry: an interrupted thread's queued runs resume (D14)",
        description: "No-op unless the thread is interrupted. Returns the thread's runs.",
        parameters: change,
        responses: {
          "200": json("ThreadRuns", "The thread's runs after resuming."),
          "404": json("Error", "`thread_not_found`."),
          "409": conflict("`thread_in_trash` or"),
          ...COMMON,
        },
      },
    },
    "/v1/runs/{id}": {
      get: {
        operationId: "getRun",
        summary: "A run's status (and its queue position while queued)",
        parameters: read,
        responses: { "200": json("Run", "The run."), "404": runNotFound, ...COMMON },
      },
      patch: {
        operationId: "updateQueuedRun",
        summary: "Edit a queued message (D17; owner only)",
        parameters: change,
        requestBody: body("UpdateQueuedBody"),
        responses: {
          "200": json("Run", "The queued run."),
          "404": runNotFound,
          "409": conflict("`invalid_transition` (not queued) or"),
          ...COMMON,
        },
      },
    },
    "/v1/runs/{id}/steer": {
      post: {
        operationId: "steerRun",
        summary: "Steer now: inject a message into the active run at Pi's next safe point (D17)",
        parameters: change,
        requestBody: body("SteerBody"),
        responses: {
          "200": json("Run", "The run; `steer.applied` is on its event stream."),
          "404": runNotFound,
          "409": conflict("`invalid_transition` (not running in the workspace) or"),
          "503": json("Error", "`sandbox_unavailable`: the workspace did not answer."),
          ...COMMON,
        },
      },
    },
    "/v1/runs/{id}/cancel": {
      post: {
        operationId: "cancelRun",
        summary: "Stop: cancel the active run (Pi aborts), or delete a queued message (D17)",
        description:
          "The run ends `cancelled` at once with `run.interrupted {reason: cancelled}`; queued " +
          "messages stay and the next one starts. Idempotent for a cancelled run.",
        parameters: change,
        responses: {
          "200": json("Run", "The cancelled run."),
          "404": runNotFound,
          "409": conflict("`invalid_transition` (already ended), `thread_in_trash` or"),
          ...COMMON,
        },
      },
    },
    "/v1/runs/{id}/retry": {
      post: {
        operationId: "retryRun",
        summary:
          "Retry from last entry: re-run an interrupted run as a new run, ahead of the queue",
        description:
          "Only the thread's latest ended run, only if interrupted, at most once (a repeat returns " +
          "the same retry run). The retry re-sends the original message from the same branch " +
          "point, so the interrupted branch stays in history (D14).",
        parameters: change,
        responses: {
          "201": json("SubmitMessageResult", "The retry run."),
          "404": runNotFound,
          "409": conflict("`invalid_transition` (not interrupted / not the latest), or"),
          "429": json("Error", "`budget_exhausted`."),
          "503": json("Error", "`isolation_unavailable`."),
          ...COMMON,
        },
      },
    },
  };
}

export function runsOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    Run: withoutDialect(output(runSnapshotSchema)),
    ThreadRuns: withoutDialect(output(threadRunsSchema)),
    SubmitMessageBody: withoutDialect(input(submitMessageBodySchema)),
    SubmitMessageResult: withoutDialect(output(submitMessageResultSchema)),
    SteerBody: withoutDialect(input(steerBodySchema)),
    UpdateQueuedBody: withoutDialect(input(updateQueuedBodySchema)),
  };
}
