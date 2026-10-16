import { z } from "zod";
import {
  runSnapshotSchema,
  steerBodySchema,
  submitMessageBodySchema,
  submitMessageResultSchema,
  updateQueuedBodySchema,
} from "@kobe/protocol";
import { queueOrderBodySchema } from "../runs/queue-order.js";

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

/**
 * The thread's active run (if any), then its queued runs in start order; and, while the thread is
 * `interrupted`, the interrupted run it waits on (offer Retry for it), else null. `queue_paused`:
 * the user stopped the active run while messages were queued, so they wait (offer Resume; a new
 * message also resumes the queue).
 */
export const threadRunsSchema = z.strictObject({
  runs: z.array(runSnapshotSchema),
  interrupted_run: runSnapshotSchema.nullable(),
  queue_paused: z.boolean(),
});

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
          "from an entry (edit-and-regenerate); absent = the thread's leaf when the run starts. " +
          "`mentions` (KOBE-223) lists the workspace paths the member picked with `@`: each must be " +
          "a live file of the owner's synced workspace with no invisible, format or shell " +
          "characters, and only its `@file(<path>)` marker in `content` is replaced by the " +
          "absolute `/workspace/...` path before the run is stored; any other `@file(...)` text " +
          "stays as written. Steering and editing a queued message take `mentions` the same way.",
        parameters: [
          ...change,
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            description:
              "Client-chosen key (1–128 visible ASCII characters), unique per thread: repeating " +
              "the request with the same key answers with the run the first one created.",
            schema: { type: "string", minLength: 1, maxLength: 128 },
          },
        ],
        requestBody: body("SubmitMessageBody"),
        responses: {
          "201": json("SubmitMessageResult", "The run, and whether it waits in the queue."),
          "404": json(
            "Error",
            "`thread_not_found`, `entry_not_found` or `file_not_found` (unknown, someone else's " +
              "or another thread's `file_ids`).",
          ),
          "409": conflict(
            "`thread_in_trash`, `queue_full`, `file_in_use` (already attached), `no_active_team`, " +
              "`team_mismatch`, or",
          ),
          "413": json(
            "Error",
            "`message_too_large`: the files add up to more than one message may (403 `quota_exceeded`: no storage left).",
          ),
          "422": json(
            "Error",
            "`attachments_unavailable` (this site has no workspace storage) or " +
              "`invalid_parent_entry` (`parent_entry_id` is a note from Kobe, not a message), or " +
              "`invalid_mention` (a `mentions` path is outside `/workspace`, holds invisible, " +
              "format or shell characters, or is not a file in the workspace).",
          ),
          "429": json("Error", "`budget_exhausted`: no new runs at 100 % of a budget (D30)."),
          "503": json(
            "Error",
            "`isolation_unavailable`: agents are disabled (D4); or `storage_unavailable`.",
          ),
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
          "200": json(
            "ThreadRuns",
            "Active run first, then the queue (`queue_pos` 1 = next); `interrupted_run` while the " +
              "thread is interrupted; `queue_paused` after a Stop with messages queued.",
          ),
          "404": json("Error", "`thread_not_found`."),
          ...COMMON,
        },
      },
    },
    "/v1/threads/{id}/queue/resume": {
      post: {
        operationId: "resumeThreadQueue",
        summary:
          "Resume the queue: after a Stop, or Continue without retry on an interrupted thread (D14)",
        description:
          "Queued runs start in order. No-op unless the thread is interrupted or its queue was " +
          "paused by a Stop. Returns the thread's runs.",
        parameters: change,
        responses: {
          "200": json("ThreadRuns", "The thread's runs after resuming."),
          "404": json("Error", "`thread_not_found`."),
          "409": conflict("`thread_in_trash` or"),
          ...COMMON,
        },
      },
    },
    "/v1/threads/{id}/queue/pause": {
      post: {
        operationId: "pauseThreadQueue",
        summary: "Pause the queue: queued messages wait until resumed (CE10; owner only)",
        description:
          "The active run goes on; the queued messages don't start until `queue/resume` or a " +
          "new message. A queued Retry still runs first (D14). No-op when no message is " +
          "queued. Returns the thread's runs.",
        parameters: change,
        responses: {
          "200": json("ThreadRuns", "The thread's runs; `queue_paused` is true while any wait."),
          "404": json("Error", "`thread_not_found`."),
          "409": conflict("`thread_in_trash` or"),
          ...COMMON,
        },
      },
    },
    "/v1/threads/{id}/queue/order": {
      post: {
        operationId: "reorderThreadQueue",
        summary: "Reorder the queued messages (CE10; owner only)",
        description:
          "`run_ids` names every queued run of the thread once, in the new order. Retries still " +
          "run first (D14). Returns the thread's runs.",
        parameters: change,
        requestBody: body("QueueOrderBody"),
        responses: {
          "200": json("ThreadRuns", "The thread's runs in the new order."),
          "404": json("Error", "`thread_not_found`."),
          "409": conflict(
            "`queue_changed` (the ids are not the queued set: read the queue again), " +
              "`thread_in_trash` or",
          ),
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
          "The run ends `cancelled` at once with `run.interrupted {reason: cancelled}`. Stopping " +
          "the active run pauses the messages queued behind it (`queue_paused`) until the user " +
          "resumes the queue or sends a new message; deleting a queued message does not pause. " +
          "Idempotent for a cancelled run.",
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
    QueueOrderBody: withoutDialect(input(queueOrderBodySchema)),
  };
}
