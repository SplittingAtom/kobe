import { z } from "zod";
import { siteBrandingSchema } from "@kobe/protocol";
import { brandingPutSchema } from "../routes/site-branding.js";

/**
 * OpenAPI for the site branding reads and the settings write (KOBE-497/499, theming TH6; the
 * logo theme colour and its variants, KOBE-562), generated from the zod schemas the routes use.
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

const branding = json("SiteBranding", "The site branding.");

export function brandingOpenApiPaths(): Record<string, Record<string, unknown>> {
  return {
    "/v1/site/branding": {
      get: {
        operationId: "getSiteBranding",
        summary: "The site's name, logo, favicon, theme and logo theme colour (public)",
        description:
          "No session needed. Asset URLs carry the file's sha256 (`?v=`). While " +
          "`logoThemeColor` is on and the logo is an SVG, `logo.inline` names its inline-safe " +
          "variant (fills and strokes in currentColor, no style, prefixed ids) and `logo.dark` " +
          "is left out; an SVG favicon is then served with its own light/dark colours.",
        security: [],
        responses: {
          "200": branding,
          "304": { description: "Unchanged (If-None-Match matched the ETag)." },
        },
      },
      put: {
        operationId: "putSiteBranding",
        summary: "Change the name, name visibility, theme or logo theme colour",
        description:
          "Needs `site.settings.manage`. One `site.branding.updated` audit event per changed " +
          "setting (`logo_theme_color` for `logoThemeColor`).",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/PutSiteBrandingBody" } },
          },
        },
        responses: {
          "200": branding,
          "400": json("Error", "`invalid_request`: no field, or an invalid one."),
          "401": json("Error", "`unauthenticated`: no session."),
          "403": json("Error", "`forbidden`: not an Owner or Admin."),
          "422": json("Error", "`contrast_floor`: the custom accent is under the floor."),
        },
      },
    },
    "/v1/site/branding/assets/{kind}": {
      get: {
        operationId: "getSiteBrandingAsset",
        summary: "A branding file (public)",
        description:
          "Immutable when `v` is the served file's sha256, else `no-cache` with an ETag; always " +
          "`X-Content-Type-Options: nosniff` and a sandboxing CSP. `inline=1` (logo only) serves " +
          "the inline-safe SVG variant while the logo theme colour is on.",
        security: [],
        parameters: [
          {
            name: "kind",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["logo", "logo_dark", "favicon"] },
          },
          { name: "v", in: "query", required: false, schema: { type: "string" } },
          { name: "inline", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
        ],
        responses: {
          "200": {
            description: "The file, with its detected content type.",
            content: {
              "image/png": {},
              "image/jpeg": {},
              "image/webp": {},
              "image/svg+xml": {},
              "image/x-icon": {},
            },
          },
          "304": { description: "Unchanged." },
          "404": json("Error", "`not_found`: no such file or variant."),
        },
      },
    },
  };
}

export function brandingOpenApiSchemas(): Record<string, JsonSchema> {
  return {
    SiteBranding: schemaOf(siteBrandingSchema, "output"),
    PutSiteBrandingBody: schemaOf(brandingPutSchema, "input"),
  };
}
