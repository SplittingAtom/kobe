import {
  FILE_THREADS_MAX_PATHS,
  fileThreadsResponseSchema,
  THREAD_FILE_LINKS_MAX_THREADS,
  threadFileLinksResponseSchema,
  threadFileLinksSchema,
} from "@kobe/protocol";
import { z } from "zod";

/**
 * OpenAPI for thread–file links (KOBE-611, spec thread-file-map §4, TFM7;
 * `routes/thread-file-links.ts`), generated from the protocol schemas the routes answer with.
 */

type JsonSchema = Record<string, unknown>;

const schemaOf = (schema: z.ZodType): JsonSchema => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io: "output",
    target: "draft-2020-12",
  }) as JsonSchema;
  return rest;
};

const json = (schemaName: string, description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

const teamHeader = {
  name: "X-Kobe-Team",
  in: "header",
  required: false,
  description: "The team the client believes is active; must match when sent.",
  schema: { type: "string", format: "uuid" },
};

const listParameter = (name: string, max: number, description: string) => ({
  name,
  in: "query",
  required: true,
  description:
    `${description} At most ${max}. Comma-separated in one parameter, or the parameter ` +
    "repeated (repeated values are taken whole, so a value may contain a comma).",
  schema: { type: "string" },
});

const ERRORS = {
  "400": json("Error", "`invalid_request` (missing, unknown or invalid parameters, over the cap)."),
  "401": json("Error", "`unauthenticated`: no session."),
  "403": json("Error", "`not_a_team_member` or `forbidden`."),
  "409": json("Error", "`no_active_team` or `team_mismatch`."),
};

const PRIVACY =
  "Only threads the caller may read; a file is named only if it is in the caller's own " +
  "workspace or in a project they can read (paths as `GET /v1/workspace/files` names them, " +
  "project files under `projects/<slug>/`). Other files are counted in `hidden_count` (TFM7).";

export function threadFileLinksOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/threads/file-links": {
      get: {
        operationId: "listThreadFileLinks",
        summary: "The files each of several threads read or wrote, in one call",
        description: `${PRIVACY} Ids the caller may not read are left out.`,
        parameters: [
          listParameter("threads", THREAD_FILE_LINKS_MAX_THREADS, "Thread ids."),
          teamHeader,
        ],
        responses: { "200": json("ThreadFileLinksList", "Links per readable thread."), ...ERRORS },
      },
    },
    "/v1/threads/{id}/file-links": {
      get: {
        operationId: "getThreadFileLinks",
        summary: "The files one thread read or wrote",
        description: PRIVACY,
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          teamHeader,
        ],
        responses: {
          "200": json("ThreadFileLinks", "The thread's links."),
          "404": json("Error", "`thread_not_found`: unknown, or not readable by the caller."),
          ...ERRORS,
        },
      },
    },
    "/v1/workspace/file-threads": {
      get: {
        operationId: "listFileThreads",
        summary: "The threads that used each of several workspace paths, newest first",
        description:
          "At most 20 threads per path: live threads the caller may read, by title; `more` " +
          "counts the rest (unreadable, in Trash, beyond the cap). A path the caller cannot see " +
          "has no threads.",
        parameters: [
          listParameter("paths", FILE_THREADS_MAX_PATHS, "Workspace-tree paths."),
          teamHeader,
        ],
        responses: { "200": json("FileThreads", "Threads per path, in request order."), ...ERRORS },
      },
    },
  };
}

export function threadFileLinksOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    ThreadFileLinks: schemaOf(threadFileLinksSchema),
    ThreadFileLinksList: schemaOf(threadFileLinksResponseSchema),
    FileThreads: schemaOf(fileThreadsResponseSchema),
  };
}
