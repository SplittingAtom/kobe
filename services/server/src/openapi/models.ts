import { z } from "zod";
import { aliasSchema, teamModelSchema } from "../models/schemas.js";

/**
 * OpenAPI for the team's models (`routes/team-models.ts`, KOBE-40/44): the catalog the chat's
 * model picker and context gauge read (KOBE-210: `context_window`, null when unknown).
 * `teamModelsResponseSchema` is the answer's contract; the route tests parse real answers with it.
 */

type JsonSchema = Record<string, unknown>;

const jsonSchema = (schema: z.ZodType, io: "input" | "output"): JsonSchema => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
  }) as JsonSchema;
  return rest;
};

const tokens = z.number().int().positive().nullable();
const price = z.number().nonnegative().nullable();

export const teamModelResponseSchema = z.strictObject({
  alias: z.string(),
  provider_id: z.string(),
  model: z.string(),
  label: z.string().nullable(),
  /** `text`, plus `image` when the model can see images. */
  input_modalities: z.array(z.enum(["text", "image"])),
  /** Output limit in tokens; null: the site default. */
  max_output_tokens: tokens,
  /** Context window in tokens; null: unknown (the chat's gauge then shows tokens only). */
  context_window: tokens,
  reasoning: z.boolean(),
  gateway_model: z.string(),
  input_usd_per_mtok: price,
  output_usd_per_mtok: price,
  cache_read_usd_per_mtok: price,
  cache_write_usd_per_mtok: price,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  /** The team enabled it: members' agents and threads may use it. */
  enabled: z.boolean(),
  is_default: z.boolean(),
});

export const teamModelsResponseSchema = z.strictObject({
  /** The whole site catalog by alias, with the team's choice. */
  models: z.array(teamModelResponseSchema),
  /** The team's default alias; null when it has none. */
  default: z.string().nullable(),
});

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

const ERRORS = {
  "401": json("Error", "`unauthenticated`: no session."),
  "403": json("Error", "`not_a_team_member` or `forbidden` (team role)."),
  "409": json("Error", "`no_active_team` or `team_mismatch` (stale tab)."),
} as const;

export function modelsOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/team/models": {
      get: {
        operationId: "listTeamModels",
        summary: "The site's model catalog with what the active team enabled",
        description:
          "Every member reads it (the chat's model picker and context gauge). Blank limits " +
          "are null: `context_window` null means the window is unknown.",
        parameters: [teamHeader(false)],
        responses: { "200": json("TeamModels", "The catalog, by alias."), ...ERRORS },
      },
    },
    "/v1/team/models/{alias}": {
      put: {
        operationId: "setTeamModel",
        summary: "Enable or disable a catalog model for the team, or make it the default",
        description: "Team admins (`team.models.manage`). Only an enabled model can be default.",
        parameters: [
          { name: "alias", in: "path", required: true, schema: jsonSchema(aliasSchema, "input") },
          teamHeader(true),
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/SetTeamModelBody" } },
          },
        },
        responses: {
          "200": json("TeamModels", "The catalog after the change."),
          "400": json("Error", "`invalid_request`: a bad body, or a default that isn't enabled."),
          ...ERRORS,
          "404": json("Error", "`model_not_found`: the alias is not in the site's catalog."),
        },
      },
    },
  };
}

export function modelsOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    TeamModels: jsonSchema(teamModelsResponseSchema, "output"),
    SetTeamModelBody: jsonSchema(teamModelSchema, "input"),
  };
}
