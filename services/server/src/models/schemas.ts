import {
  INPUT_MODALITIES,
  MAX_USD_PER_MTOK,
  MODEL_ALIAS_PATTERN,
  MODEL_PROVIDER_KINDS,
  PROVIDER_ID_PATTERN,
  PROVIDER_MODEL_PATTERN,
} from "@kobe/db";
import { z } from "zod";

/** Request bodies of the model admin API (KOBE-40). Errors never echo input (keys). */

export const providerIdSchema = z.string().max(32).regex(new RegExp(PROVIDER_ID_PATTERN));
export const aliasSchema = z.string().max(64).regex(new RegExp(MODEL_ALIAS_PATTERN));
const modelSchema = z
  .string()
  .max(200)
  .regex(new RegExp(PROVIDER_MODEL_PATTERN), "model must be the provider's model id");
const nameSchema = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(100, "name is at most 100 characters")
  .regex(/^[^\p{Cc}]*$/u, "name must not contain control characters");
const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(200, "label is at most 200 characters")
  .regex(/^[^\p{Cc}]*$/u, "label must not contain control characters");

/** An API key: printable, no whitespace (pasted keys are trimmed). */
const apiKeySchema = z
  .string()
  .trim()
  .min(1, "api_key must not be empty")
  .max(4096, "api_key is too long")
  .regex(/^[\x21-\x7e]+$/, "api_key must be printable ASCII without spaces");

/** An http(s) endpoint without credentials, query or fragment. */
export const baseUrlSchema = z
  .string()
  .trim()
  .max(2048, "base_url is too long")
  .refine((v) => {
    if (!URL.canParse(v)) return false;
    const u = new URL(v);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.username === "" &&
      u.password === "" &&
      u.search === "" &&
      u.hash === ""
    );
  }, "base_url must be an http(s) URL without credentials, query or fragment")
  .transform((v) => v.replace(/\/+$/, ""));

export const addProviderSchema = z
  .strictObject({
    kind: z.enum(MODEL_PROVIDER_KINDS, { error: "kind is not a supported provider kind" }),
    /** Vendor kinds are their own id; OpenAI-compatible endpoints need one. */
    id: providerIdSchema.optional(),
    name: nameSchema,
    base_url: baseUrlSchema.optional(),
    api_key: apiKeySchema.optional(),
    allow_private_network: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "openai_compatible") {
      if (!v.id) ctx.addIssue({ code: "custom", message: "id is required for this kind" });
    } else if (v.id !== undefined && v.id !== v.kind) {
      ctx.addIssue({ code: "custom", message: "id must equal kind for this provider" });
    }
    if ((v.kind === "ollama" || v.kind === "openai_compatible") && !v.base_url) {
      ctx.addIssue({ code: "custom", message: "base_url is required for this kind" });
    }
    if ((v.kind === "openai" || v.kind === "anthropic" || v.kind === "gemini") && !v.api_key) {
      ctx.addIssue({ code: "custom", message: "api_key is required for this kind" });
    }
  });
export type AddProviderInput = z.infer<typeof addProviderSchema>;

export const updateProviderSchema = z
  .strictObject({
    name: nameSchema.optional(),
    base_url: baseUrlSchema.nullable().optional(),
    /** A new key; null removes it (only for kinds that work without one). */
    api_key: apiKeySchema.nullable().optional(),
    allow_private_network: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "nothing to change");
export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;

/** Dollars per million tokens (KOBE-43); null clears it. Stored to six decimals. */
const priceSchema = z
  .number({ error: "prices are numbers (dollars per million tokens)" })
  .min(0, "prices cannot be negative")
  .max(MAX_USD_PER_MTOK, `prices are at most ${MAX_USD_PER_MTOK} dollars per million tokens`)
  .nullable();

/** Optional catalog prices; without input and output prices calls have no cost (D30 budgets). */
const priceFields = {
  input_usd_per_mtok: priceSchema.optional(),
  output_usd_per_mtok: priceSchema.optional(),
  cache_read_usd_per_mtok: priceSchema.optional(),
  cache_write_usd_per_mtok: priceSchema.optional(),
};

/**
 * What a model accepts as input (KOBE-191). `text` is implied: the stored list always starts with
 * it, so a client may send just `["image"]`.
 */
const inputModalitiesSchema = z
  .array(z.enum(INPUT_MODALITIES, { error: "input modalities are text and image" }))
  .max(INPUT_MODALITIES.length)
  .transform((v) => INPUT_MODALITIES.filter((m) => m === "text" || v.includes(m)));

export const addCatalogSchema = z.strictObject({
  alias: aliasSchema,
  provider_id: providerIdSchema,
  model: modelSchema,
  label: labelSchema.optional(),
  input_modalities: inputModalitiesSchema.optional(),
  ...priceFields,
});
export type AddCatalogInput = z.infer<typeof addCatalogSchema>;

export const updateCatalogSchema = z
  .strictObject({
    provider_id: providerIdSchema.optional(),
    model: modelSchema.optional(),
    label: labelSchema.nullable().optional(),
    input_modalities: inputModalitiesSchema.optional(),
    ...priceFields,
  })
  .refine((v) => Object.keys(v).length > 0, "nothing to change");
export type UpdateCatalogInput = z.infer<typeof updateCatalogSchema>;

export const teamModelSchema = z.strictObject({
  enabled: z.boolean(),
  /** Make this the team's default (requires enabled). */
  is_default: z.boolean().optional(),
});
export type TeamModelInput = z.infer<typeof teamModelSchema>;

/** Catalog size bound (install-wide table; keeps the gateway sync and team pages small). */
export const MAX_CATALOG_ENTRIES = 200;
export const MAX_PROVIDERS = 50;
