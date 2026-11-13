import { z } from "zod";
import {
  SEMANTIC_MEMORY_KINDS,
  SEMANTIC_MEMORY_PAGE_DEFAULT,
  SEMANTIC_MEMORY_PAGE_MAX,
  SEMANTIC_MEMORY_SCOPES,
  SEMANTIC_MEMORY_STATUSES,
  createSemanticMemoryItemSchema,
  memoryStewardListSchema,
  memoryStewardSchema,
  patchSemanticMemoryItemSchema,
  pinSemanticMemoryItemSchema,
  revertSemanticMemoryItemSchema,
  semanticMemoryErrorSchema,
  semanticMemoryExportDocumentSchema,
  semanticMemoryImportCommitRequestSchema,
  semanticMemoryImportCommitResponseSchema,
  semanticMemoryImportPreviewRequestSchema,
  semanticMemoryImportPreviewResponseSchema,
  semanticMemoryItemDetailSchema,
  semanticMemoryListResponseSchema,
} from "@kobe/protocol";

/**
 * OpenAPI for semantic memory (v1.3, KOBE-377 contract; schemas in `@kobe/protocol`
 * semantic-memory/). Documented before the routes exist: KOBE-378 mounts the item routes,
 * KOBE-384/385 import and export, KOBE-380 the steward routes. Wire scopes are
 * `user | portable | team | site`; `team` is the Workspace.
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

const body = (schemaName: string) => ({
  required: true,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } },
});

const TEAM_HEADER = {
  name: "X-Kobe-Team",
  in: "header",
  required: false,
  description: "The Workspace the client believes is active; must match when sent.",
  schema: { type: "string", format: "uuid" },
};

const scopeParam = (where: "path" | "query") => ({
  name: "scope",
  in: where,
  required: true,
  description:
    "`user` (me in this Workspace), `portable` (all my Workspaces), `team` (this Workspace), `site`.",
  schema: { type: "string", enum: [...SEMANTIC_MEMORY_SCOPES] },
});
const ID = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const USER_ID = {
  name: "userId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const query = (name: string, schema: JsonSchema, description?: string) => ({
  name,
  in: "query",
  required: false,
  ...(description ? { description } : {}),
  schema,
});

const ERR = (description: string) => json("SemanticMemoryError", description);
const COMMON = {
  "401": json("Error", "`unauthenticated`: no session."),
  "403": ERR("`memory_not_allowed`, or `not_a_team_member`."),
  "409": ERR("`memory_disabled`, `no_active_team` or `team_mismatch`."),
};
const SAVE_ERRORS = {
  "400": json("Error", "`invalid_request`: the body does not match."),
  "404": ERR("`memory_item_not_found`."),
  "409": ERR(
    "`memory_lint_warning` or `memory_policy_conflict` (send `overrides` to save anyway; " +
      "audited), `memory_scope_full`, `memory_policy_budget_full`, `memory_version_conflict`, " +
      "`memory_item_inactive`, `memory_disabled`, `no_active_team` or `team_mismatch`.",
  ),
  "422": ERR("`memory_secret`: a credential was found; it can never be saved."),
};
const DETAIL = json("SemanticMemoryItemDetail", "The item with its versions, newest first.");

const itemAction = (operationId: string, summary: string, bodyName?: string) => ({
  post: {
    operationId,
    summary,
    parameters: [scopeParam("path"), ID, TEAM_HEADER],
    ...(bodyName ? { requestBody: body(bodyName) } : {}),
    responses: { "200": DETAIL, ...COMMON, ...SAVE_ERRORS },
  },
});

function itemPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/memory/items": {
      get: {
        operationId: "listSemanticMemoryItems",
        summary: "List one scope's memory items, newest first",
        description:
          "Personal scopes are always the caller's own. Workspace and Site items are read by " +
          "every member; curators (Team admins and stewards) and Site stewards change them.",
        parameters: [
          scopeParam("query"),
          query("status", {
            type: "string",
            enum: [...SEMANTIC_MEMORY_STATUSES],
            default: "active",
          }),
          query("kind", { type: "string", enum: [...SEMANTIC_MEMORY_KINDS] }),
          query("pinned", { type: "boolean" }),
          query("policy", { type: "boolean" }, "Site only: Policy items, or all but Policy."),
          query("q", { type: "string", maxLength: 200 }, "Full-text and trigram search."),
          query("limit", {
            type: "integer",
            minimum: 1,
            maximum: SEMANTIC_MEMORY_PAGE_MAX,
            default: SEMANTIC_MEMORY_PAGE_DEFAULT,
          }),
          query("cursor", { type: "string" }),
          TEAM_HEADER,
        ],
        responses: {
          "200": json("SemanticMemoryList", "A page of items and how full the scope is."),
          "400": json("Error", "`invalid_request`: a query parameter does not match."),
          ...COMMON,
        },
      },
      post: {
        operationId: "createSemanticMemoryItem",
        summary: "Save a memory item",
        description:
          "Runs the save checks (secret scan, lint, Policy conflict, limits). Portable items " +
          "are preferences; Policy exists only on the Site.",
        parameters: [TEAM_HEADER],
        requestBody: body("CreateSemanticMemoryItem"),
        responses: {
          "201": DETAIL,
          ...COMMON,
          ...SAVE_ERRORS,
        },
      },
    },
    "/v1/memory/items/{scope}/{id}": {
      get: {
        operationId: "getSemanticMemoryItem",
        summary: "A memory item with its versions",
        parameters: [scopeParam("path"), ID, TEAM_HEADER],
        responses: { "200": DETAIL, ...COMMON, "404": ERR("`memory_item_not_found`.") },
      },
      patch: {
        operationId: "editSemanticMemoryItem",
        summary: "Edit a memory item (a statement change adds a version)",
        parameters: [scopeParam("path"), ID, TEAM_HEADER],
        requestBody: body("PatchSemanticMemoryItem"),
        responses: { "200": DETAIL, ...COMMON, ...SAVE_ERRORS },
      },
    },
    "/v1/memory/items/{scope}/{id}/archive": itemAction(
      "archiveSemanticMemoryItem",
      "Archive a memory item (never deleted; its versions stay)",
    ),
    "/v1/memory/items/{scope}/{id}/restore": itemAction(
      "restoreSemanticMemoryItem",
      "Restore an archived memory item",
    ),
    "/v1/memory/items/{scope}/{id}/revert": itemAction(
      "revertSemanticMemoryItem",
      "Undo: save an earlier version as the newest",
      "RevertSemanticMemoryItem",
    ),
    "/v1/memory/items/{scope}/{id}/pin": itemAction(
      "pinSemanticMemoryItem",
      "Pin or unpin a memory item (pinned items are always in context)",
      "PinSemanticMemoryItem",
    ),
  };
}

function transferPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/memory/import/preview": {
      post: {
        operationId: "previewSemanticMemoryImport",
        summary: "Check a JSON or CSV file row by row; stores nothing",
        parameters: [TEAM_HEADER],
        requestBody: body("SemanticMemoryImportPreviewRequest"),
        responses: {
          "200": json("SemanticMemoryImportPreview", "Each row with its status and issues."),
          "400": ERR("`memory_import_invalid`, or `invalid_request`."),
          ...COMMON,
        },
      },
    },
    "/v1/memory/import/commit": {
      post: {
        operationId: "commitSemanticMemoryImport",
        summary: "Save the accepted rows of an import (the checks run again)",
        parameters: [TEAM_HEADER],
        requestBody: body("SemanticMemoryImportCommitRequest"),
        responses: {
          "200": json("SemanticMemoryImportCommit", "What was saved and skipped."),
          "400": ERR("`memory_import_invalid`, or `invalid_request`."),
          ...COMMON,
          "409": ERR(
            "`memory_scope_full`, `memory_disabled`, `no_active_team` or `team_mismatch`.",
          ),
        },
      },
    },
    "/v1/memory/export": {
      get: {
        operationId: "exportSemanticMemory",
        summary: "Download one scope as JSON or CSV",
        parameters: [
          scopeParam("query"),
          query("format", { type: "string", enum: ["json", "csv"], default: "json" }),
          query("include_inactive", { type: "boolean", default: false }),
          TEAM_HEADER,
        ],
        responses: {
          "200": {
            description: "The export: JSON (also a valid import file) or CSV with a header row.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SemanticMemoryExport" },
              },
              "text/csv": { schema: { type: "string" } },
            },
          },
          ...COMMON,
        },
      },
    },
  };
}

function stewardPaths(): Record<string, Record<string, unknown>> {
  const list = (description: string) => json("MemoryStewardList", description);
  return {
    "/v1/team/memory/stewards": {
      get: {
        operationId: "listWorkspaceMemoryStewards",
        summary: "The Workspace's memory stewards (Team admins)",
        parameters: [TEAM_HEADER],
        responses: { "200": list("Workspace stewards."), ...COMMON },
      },
    },
    "/v1/team/memory/stewards/{userId}": {
      put: {
        operationId: "grantWorkspaceMemorySteward",
        summary: "Make a Workspace member a memory steward (any role)",
        parameters: [USER_ID, TEAM_HEADER],
        responses: {
          "200": json("MemorySteward", "The grant."),
          ...COMMON,
          "404": json("Error", "`user_not_found`: not a member of this Workspace."),
        },
      },
      delete: {
        operationId: "revokeWorkspaceMemorySteward",
        summary: "Take a member's memory steward grant",
        parameters: [USER_ID, TEAM_HEADER],
        responses: {
          "204": { description: "Taken." },
          ...COMMON,
          "404": json("Error", "`not_found`: that member is not a steward."),
        },
      },
    },
    "/v1/site/memory/stewards": {
      get: {
        operationId: "listSiteMemoryStewards",
        summary: "The Site's memory stewards (Site admins)",
        description:
          "The `memory_steward` site grant; given and taken with " +
          "`PUT/DELETE /v1/site/roles/grants/{userId}/memory_steward`.",
        responses: { "200": list("Site stewards."), ...COMMON },
      },
    },
  };
}

export function semanticMemoryOpenApiPaths(): Record<string, Record<string, unknown>> {
  return { ...itemPaths(), ...transferPaths(), ...stewardPaths() };
}

export function semanticMemoryOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    SemanticMemoryList: schemaOf(semanticMemoryListResponseSchema, "output"),
    SemanticMemoryItemDetail: schemaOf(semanticMemoryItemDetailSchema, "output"),
    CreateSemanticMemoryItem: schemaOf(createSemanticMemoryItemSchema, "input"),
    PatchSemanticMemoryItem: schemaOf(patchSemanticMemoryItemSchema, "input"),
    RevertSemanticMemoryItem: schemaOf(revertSemanticMemoryItemSchema, "input"),
    PinSemanticMemoryItem: schemaOf(pinSemanticMemoryItemSchema, "input"),
    SemanticMemoryImportPreviewRequest: schemaOf(semanticMemoryImportPreviewRequestSchema, "input"),
    SemanticMemoryImportPreview: schemaOf(semanticMemoryImportPreviewResponseSchema, "output"),
    SemanticMemoryImportCommitRequest: schemaOf(semanticMemoryImportCommitRequestSchema, "input"),
    SemanticMemoryImportCommit: schemaOf(semanticMemoryImportCommitResponseSchema, "output"),
    SemanticMemoryExport: schemaOf(semanticMemoryExportDocumentSchema, "output"),
    SemanticMemoryError: schemaOf(semanticMemoryErrorSchema, "output"),
    MemorySteward: schemaOf(memoryStewardSchema, "output"),
    MemoryStewardList: schemaOf(memoryStewardListSchema, "output"),
  };
}
