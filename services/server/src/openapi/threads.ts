import { z } from "zod";
import {
  createThreadBodySchema,
  createdThreadSchema,
  entriesQuerySchema,
  entryPageSchema,
  errorSchema,
  listThreadsQuerySchema,
  setLeafBodySchema,
  threadDetailSchema,
  threadPageSchema,
  threadSummarySchema,
  trashQuerySchema,
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
          "(KOBE-33; 501 `search_unavailable` until wired). Reads Postgres only (never wakes a sandbox).",
        parameters: [...queryParameters(listThreadsQuerySchema), teamHeader],
        responses: {
          "200": json("ThreadPage", "A page of threads."),
          "501": json("Error", "`search_unavailable`."),
          ...ERROR_RESPONSES,
        },
      },
      post: {
        operationId: "createThread",
        summary: "Create a thread in the active team, owned by the caller",
        parameters: change(),
        requestBody: body("CreateThreadBody"),
        responses: {
          "201": json("Thread", "The new thread."),
          "404": json("Error", "`agent_not_found` or `project_not_found`."),
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
    ThreadDetail: withoutDialect(output(threadDetailSchema)),
    EntryPage: withoutDialect(output(entryPageSchema)),
    CreateThreadBody: withoutDialect(input(createThreadBodySchema)),
    UpdateThreadBody: withoutDialect(input(updateThreadBodySchema)),
    SetLeafBody: withoutDialect(input(setLeafBodySchema)),
    CreatedThread: withoutDialect(output(createdThreadSchema)),
  };
}
