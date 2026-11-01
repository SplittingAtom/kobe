import {
  createThreadFolderRequestSchema,
  threadFolderSchema,
  threadFoldersResponseSchema,
  updateThreadFolderRequestSchema,
} from "@kobe/protocol";
import { z } from "zod";

/**
 * OpenAPI for the team's thread folders (KOBE-534, spec TF4; `routes/thread-folders.ts`),
 * generated from the protocol schemas the routes validate with.
 */

type JsonSchema = Record<string, unknown>;

const schemaOf = (schema: z.ZodType, io: "input" | "output"): JsonSchema => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
  }) as JsonSchema;
  return rest;
};

const json = (schemaName: string, description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

const teamHeader = (required: boolean) => ({
  name: "X-Kobe-Team",
  in: "header",
  required,
  description: "The team the client believes is active. Required on changes; must match.",
  schema: { type: "string", format: "uuid" },
});

const idParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};

const body = (schemaName: string) => ({
  required: true,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

const ERRORS = {
  "400": json("Error", "`invalid_request` or `team_header_required`."),
  "401": json("Error", "`unauthenticated`: no session."),
  "403": json("Error", "`not_a_team_member` or `forbidden`."),
};

const notFound = json("Error", "`folder_not_found`: unknown id, or another team's folder.");

export function threadFoldersOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/thread-folders": {
      get: {
        operationId: "listThreadFolders",
        summary: "Every folder of the active team, with the caller's own thread counts (TF4)",
        description:
          "At most 500, unpaged. `threads` counts the folder's own live, unarchived threads the " +
          "caller may read (not its subfolders').",
        parameters: [teamHeader(false)],
        responses: {
          "200": json("ThreadFolders", "The team's folders."),
          ...ERRORS,
          "409": json("Error", "`no_active_team` or `team_mismatch`."),
        },
      },
      post: {
        operationId: "createThreadFolder",
        summary: "Create a folder at the top level or inside one (any member; 60 per 10 min)",
        parameters: [teamHeader(true)],
        requestBody: body("CreateThreadFolderBody"),
        responses: {
          "201": json("ThreadFolder", "The new folder."),
          "404": json("Error", "`folder_not_found`: the parent is not in this team."),
          ...ERRORS,
          "409": json(
            "Error",
            "`folder_name_taken`, `folder_too_deep` (three levels), `folder_limit` (500), " +
              "`no_active_team` or `team_mismatch`.",
          ),
          "429": json("Error", "`rate_limited`."),
        },
      },
    },
    "/v1/thread-folders/{id}": {
      patch: {
        operationId: "updateThreadFolder",
        summary: "Rename, move (`parent_id: null` = top level) or reorder a folder (any member)",
        parameters: [idParameter, teamHeader(true)],
        requestBody: body("UpdateThreadFolderBody"),
        responses: {
          "200": json("ThreadFolder", "The folder."),
          "404": notFound,
          ...ERRORS,
          "409": json(
            "Error",
            "`folder_name_taken`, `folder_too_deep` (also when its subfolders would end up " +
              "deeper), `folder_cycle`, `no_active_team` or `team_mismatch`.",
          ),
        },
      },
      delete: {
        operationId: "deleteThreadFolder",
        summary: "Delete a folder and its subfolders; their threads go back to no folder",
        parameters: [idParameter, teamHeader(true)],
        responses: {
          "204": { description: "Deleted." },
          "404": notFound,
          ...ERRORS,
          "409": json("Error", "`no_active_team` or `team_mismatch`."),
        },
      },
    },
  };
}

export function threadFoldersOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    ThreadFolder: schemaOf(threadFolderSchema, "output"),
    ThreadFolders: schemaOf(threadFoldersResponseSchema, "output"),
    CreateThreadFolderBody: schemaOf(createThreadFolderRequestSchema, "input"),
    UpdateThreadFolderBody: schemaOf(updateThreadFolderRequestSchema, "input"),
  };
}
