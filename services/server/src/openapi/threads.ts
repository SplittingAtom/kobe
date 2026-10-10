import { forkThreadRequestSchema, shareThreadRequestSchema } from "@kobe/protocol";
import { z } from "zod";
import {
  createThreadBodySchema,
  createdThreadSchema,
  entriesQuerySchema,
  entryPageSchema,
  errorSchema,
  listThreadsQuerySchema,
  setLeafBodySchema,
  switchAgentVersionBodySchema,
  threadDetailSchema,
  threadPageSchema,
  threadSearchPageSchema,
  threadSummarySchema,
  trashQuerySchema,
  clearTestThreadsQuerySchema,
  updateThreadBodySchema,
} from "../threads/schemas.js";

/**
 * OpenAPI 3.1 description of the Thread API (spec §6.1, KOBE-34), generated from the zod schemas
 * the routes validate with, so the document cannot drift from the code (`openapi.test.ts` also
 * checks that every mounted route is described).
 */

type JsonSchema = Record<string, unknown>;

const input = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) as JsonSchema;
const output = (schema: z.ZodType): JsonSchema =>
  z.toJSONSchema(schema, { io: "output", target: "draft-2020-12" }) as JsonSchema;

const withoutDialect = ({ $schema: _ignored, ...rest }: JsonSchema): JsonSchema => rest;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const json = (schemaName: string, description: string) => ({
  description,
  content: { "application/json": { schema: ref(schemaName) } },
});

const ERROR_RESPONSES = {
  "400": json("Error", "`invalid_request`, `invalid_cursor` or `team_header_required`."),
  "401": json("Error", "`unauthenticated`: no session."),
  "403": json("Error", "`not_a_team_member`, `forbidden` (team role) or `read_only`."),
  "409": json("Error", "`no_active_team` or `team_mismatch` (stale tab), or a thread conflict."),
} as const;

const notFound = json("Error", "`thread_not_found`: unknown id, another team's or user's thread.");

/** Query parameters from a strict zod object (each optional, string-typed on the wire). */
function queryParameters(schema: z.ZodObject): readonly JsonSchema[] {
  const shape = (input(schema).properties ?? {}) as Record<string, JsonSchema>;
  return Object.entries(shape).map(([name, s]) => ({
    name,
    in: "query",
    required: false,
    schema: s,
  }));
}

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

const change = (parameters: readonly object[] = []) => [
  ...parameters,
  { ...teamHeader, required: true },
];

const body = (schemaName: string) => ({
  required: true,
  content: { "application/json": { schema: ref(schemaName) } },
});

export function threadsOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/threads": {
      get: {
        operationId: "listThreads",
        summary: "List the viewer's threads (or a project's readable threads), newest first",
        description:
          "Keyset pagination on (last_activity_at, id). Never Trash. With `q`, full-text search " +
          '(KOBE-33): web-search syntax (`"phrase"`, `-exclude`, `or`) over user/assistant ' +
          "messages (all terms in one message) and titles (plus fuzzy title matching), ranked by " +
          "relevance with snippets; `cursor` is then a search cursor and `limit` is capped at 50. " +
          "Reads Postgres only (never wakes a sandbox).",
        parameters: [...queryParameters(listThreadsQuerySchema), teamHeader],
        responses: {
          "200": {
            description: "A page of threads (`ThreadSearchPage` when `q` is given).",
            content: {
              "application/json": {
                schema: { oneOf: [ref("ThreadPage"), ref("ThreadSearchPage")] },
              },
            },
          },
          ...ERROR_RESPONSES,
          "400": json(
            "Error",
            "`invalid_request`, `invalid_cursor`, `invalid_query` (only excluded terms) or " +
              "`team_header_required`.",
          ),
          "503": json("Error", "`search_timeout`: the search exceeded its time limit."),
        },
      },
      post: {
        operationId: "createThread",
        summary: "Create a thread in the active team, owned by the caller",
        parameters: change(),
        requestBody: body("CreateThreadBody"),
        description:
          "With `agent_id`, the thread pins the agent's current published version (D19). " +
          "Suspended, archived and never-published agents answer 409 `agent_unavailable`. " +
          "With `test: true` (needs `agent_id`, no project) it is a builder test thread " +
          "(KOBE-85): it runs the agent's unpublished draft, needs the right to edit the agent " +
          "(else 404 `agent_not_found`), and stays out of lists, search and Trash.",
        responses: {
          "201": json("Thread", "The new thread."),
          "404": json("Error", "`agent_not_found` or `project_not_found`."),
          ...ERROR_RESPONSES,
          "409": json(
            "Error",
            "`agent_unavailable`, `no_active_team` or `team_mismatch` (stale tab).",
          ),
        },
      },
    },
    "/v1/threads/test": {
      delete: {
        operationId: "clearTestThreads",
        summary: "Clear the caller's builder test threads (KOBE-85), all or one agent's",
        description:
          "Moves them to Trash (hidden from every list); threads with an active or queued run " +
          "are skipped. Their runs and usage stay for budgets.",
        parameters: [...queryParameters(clearTestThreadsQuerySchema), teamHeader],
        responses: {
          "200": {
            description: "How many test threads were cleared.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["cleared"],
                  properties: { cleared: { type: "integer", minimum: 0 } },
                },
              },
            },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    "/v1/threads/trash": {
      get: {
        operationId: "listTrash",
        summary: "The viewer's Trash, most recently deleted first (restorable for 30 days)",
        parameters: [...queryParameters(trashQuerySchema), teamHeader],
        responses: { "200": json("ThreadPage", "A page of trashed threads."), ...ERROR_RESPONSES },
      },
    },
    "/v1/threads/{id}": {
      get: {
        operationId: "getThread",
        summary: "A thread with its entry tree (append order), leaf, agent version and status",
        description:
          "Readable by its owner, or by project members when shared. Never wakes a sandbox.",
        parameters: [idParameter, ...queryParameters(entriesQuerySchema), teamHeader],
        responses: {
          "200": json("ThreadDetail", "The thread and the first page of entries."),
          "404": notFound,
          ...ERROR_RESPONSES,
        },
      },
      patch: {
        operationId: "updateThread",
        summary: "Rename, or share to / unshare from its project (owner only)",
        parameters: change([idParameter]),
        requestBody: body("UpdateThreadBody"),
        responses: {
          "200": json("Thread", "The updated thread."),
          "404": notFound,
          ...ERROR_RESPONSES,
        },
      },
      delete: {
        operationId: "trashThread",
        summary: "Move to Trash (30-day soft delete; owner only; idempotent)",
        parameters: change([idParameter]),
        responses: {
          "200": json("Thread", "The trashed thread."),
          "404": notFound,
          ...ERROR_RESPONSES,
        },
      },
    },
    "/v1/threads/{id}/entries": {
      get: {
        operationId: "listThreadEntries",
        summary: "More entries of a thread, by seq",
        parameters: [idParameter, ...queryParameters(entriesQuerySchema), teamHeader],
        responses: {
          "200": json("EntryPage", "A page of entries."),
          "404": notFound,
          ...ERROR_RESPONSES,
        },
      },
    },
    "/v1/threads/{id}/leaf": {
      post: {
        operationId: "setThreadLeaf",
        summary: "Switch the active branch to an entry of the thread (owner only)",
        parameters: change([idParameter]),
        requestBody: body("SetLeafBody"),
        responses: {
          "200": json("Thread", "The thread with its new leaf."),
          "404": json("Error", "`thread_not_found` or `entry_not_found`."),
          ...ERROR_RESPONSES,
        },
      },
    },
    "/v1/threads/{id}/agent-version": {
      post: {
        operationId: "switchThreadAgentVersion",
        summary: "Pin another published version of the thread's agent (owner only)",
        description:
          'D19 one-click switch ("v3 available"): without `version`, the agent\'s current ' +
          "version. Refused while a run is active (`thread_busy`).",
        parameters: change([idParameter]),
        requestBody: body("SwitchAgentVersionBody"),
        responses: {
          "200": json("Thread", "The thread with its new pin."),
          "404": json("Error", "`thread_not_found`, `agent_not_found` or `version_not_found`."),
          ...ERROR_RESPONSES,
          "409": json(
            "Error",
            "`no_agent`, `agent_unavailable`, `thread_busy`, `thread_in_trash`, or a team conflict.",
          ),
        },
      },
    },
    "/v1/threads/{id}/share": {
      post: {
        operationId: "shareThread",
        summary: "Set who can read the thread: `private` or `project` (author only)",
        parameters: change([idParameter]),
        requestBody: body("ShareThreadBody"),
        responses: {
          "200": json("Thread", "The updated thread."),
          "404": notFound,
          ...ERROR_RESPONSES,
          "409": json("Error", "`not_in_project`, `thread_busy` or `thread_in_trash`."),
        },
      },
    },
    "/v1/threads/{id}/fork": {
      post: {
        operationId: "forkThread",
        summary:
          "Copy a readable thread (own, or shared to your project) into a new private thread",
        description:
          "Copies the entries from the root up to `entry_id` (default: the leaf). Workspace files are not copied.",
        parameters: change([idParameter]),
        requestBody: body("ForkThreadBody"),
        responses: {
          "201": json("CreatedThread", "The new thread."),
          "404": notFound,
          ...ERROR_RESPONSES,
          "409": json("Error", "`thread_in_trash` or `entry_offloaded`."),
        },
      },
    },
    "/v1/threads/{id}/restore": {
      post: {
        operationId: "restoreThread",
        summary: "Restore from Trash within 30 days (owner only)",
        parameters: change([idParameter]),
        responses: {
          "200": json("Thread", "The restored thread."),
          "404": notFound,
          ...ERROR_RESPONSES,
        },
      },
    },
  };
}

export function threadsOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    Error: withoutDialect(output(errorSchema)),
    Thread: withoutDialect(output(threadSummarySchema)),
    ThreadPage: withoutDialect(output(threadPageSchema)),
    ThreadSearchPage: withoutDialect(output(threadSearchPageSchema)),
    ThreadDetail: withoutDialect(output(threadDetailSchema)),
    EntryPage: withoutDialect(output(entryPageSchema)),
    CreateThreadBody: withoutDialect(input(createThreadBodySchema)),
    UpdateThreadBody: withoutDialect(input(updateThreadBodySchema)),
    ShareThreadBody: withoutDialect(input(shareThreadRequestSchema)),
    ForkThreadBody: withoutDialect(input(forkThreadRequestSchema)),
    SetLeafBody: withoutDialect(input(setLeafBodySchema)),
    SwitchAgentVersionBody: withoutDialect(input(switchAgentVersionBodySchema)),
    CreatedThread: withoutDialect(output(createdThreadSchema)),
  };
}
