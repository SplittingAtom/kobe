import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Models and the model gateway (KOBE-40, spec D6, D30). Install admins own the **providers** (with
// their API keys) and the **model catalog** (aliases such as `fast`, `smart`, `local` mapped to a
// provider's model); team admins enable a subset of the catalog with one default (`team_models`).
// Kobe is the source of truth: the server reconciles Bifrost (the gateway) from these rows, and
// sandboxes reach Bifrost only through Kobe's model-gateway shim with their session token, which
// the shim swaps for the (team, user) Bifrost virtual key in `model_gateway_keys`.

/** Provider kinds (D30): any OpenAI-compatible endpoint, Anthropic native, Gemini, local Ollama. */
export const MODEL_PROVIDER_KINDS = [
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "openai_compatible",
] as const;
export const modelProviderKind = pgEnum("model_provider_kind", MODEL_PROVIDER_KINDS);
export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number];

/** Kinds whose endpoint must be given (no public default); the others default to the vendor's. */
export const PROVIDER_KINDS_NEEDING_BASE_URL: readonly ModelProviderKind[] = [
  "ollama",
  "openai_compatible",
];
/** Kinds that need an API key (Ollama and many self-hosted OpenAI-compatible servers do not). */
export const PROVIDER_KINDS_NEEDING_KEY: readonly ModelProviderKind[] = [
  "openai",
  "anthropic",
  "gemini",
];

/** Provider id: a short slug. Vendor kinds use the kind itself (one provider per vendor). */
export const PROVIDER_ID_PATTERN = "^[a-z][a-z0-9-]{0,30}[a-z0-9]$";
/** Catalog alias (`fast`, `smart`, `local`, `claude-sonnet-4.5`): what agents name in `model:`. */
export const MODEL_ALIAS_PATTERN = "^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$";
/** A provider's model id as the provider spells it (no whitespace, no control characters). */
export const PROVIDER_MODEL_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$";

const ts = () => timestamp({ withTimezone: true }).notNull().defaultNow();

/**
 * Install-wide (†): model providers and their API keys. The key is sealed with the server's
 * provider-key secret (`secret-box.ts`, AAD bound to the provider id) and never returned by any
 * API; `key_revision` counts key changes (the gateway's copy carries it, so a change is pushed).
 */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: text().primaryKey(),
    kind: modelProviderKind().notNull(),
    /** Display name for the admin console. */
    name: text().notNull(),
    /** Endpoint override (required for Ollama and OpenAI-compatible servers). */
    baseUrl: text(),
    /** Let the gateway reach private addresses (RFC 1918) for this provider: local models. */
    allowPrivateNetwork: boolean().notNull().default(false),
    apiKeyEnc: text(),
    keyRevision: integer().notNull().default(0),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [
    check("model_providers_id", sql`${t.id} ~ ${sql.raw(`'${PROVIDER_ID_PATTERN}'`)}`),
    // A vendor kind is configured once, under its own name.
    check(
      "model_providers_vendor_id",
      sql`${t.kind} = 'openai_compatible' OR ${t.id} = ${t.kind}::text`,
    ),
    check(
      "model_providers_base_url",
      sql`CASE WHEN ${t.baseUrl} IS NULL THEN ${t.kind} NOT IN ('ollama', 'openai_compatible')
        ELSE ${t.baseUrl} ~ '^https?://' AND char_length(${t.baseUrl}) <= 2048 END`,
    ),
    check(
      "model_providers_key",
      sql`${t.kind} IN ('ollama', 'openai_compatible') OR ${t.apiKeyEnc} IS NOT NULL`,
    ),
    check("model_providers_name", sql`char_length(${t.name}) BETWEEN 1 AND 100`),
    check("model_providers_key_revision", sql`${t.keyRevision} >= 0`),
  ],
);

/**
 * Install-wide (†): the model catalog (the ceiling teams choose from). Deleting an alias removes
 * every team's enablement of it (cascade into `team_models`, audited); a provider with catalog
 * entries cannot be deleted.
 */
export const modelCatalog = pgTable(
  "model_catalog",
  {
    alias: text().primaryKey(),
    providerId: text()
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    model: text().notNull(),
    label: text(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [
    check("model_catalog_alias", sql`${t.alias} ~ ${sql.raw(`'${MODEL_ALIAS_PATTERN}'`)}`),
    check("model_catalog_model", sql`${t.model} ~ ${sql.raw(`'${PROVIDER_MODEL_PATTERN}'`)}`),
    check(
      "model_catalog_label",
      sql`${t.label} IS NULL OR char_length(${t.label}) BETWEEN 1 AND 200`,
    ),
  ],
);

/** Team table: the catalog aliases a team enabled, at most one of them its default. */
export const teamModels = pgTable(
  "team_models",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    alias: text()
      .notNull()
      .references(() => modelCatalog.alias, { onDelete: "cascade" }),
    isDefault: boolean().notNull().default(false),
    enabledBy: uuid()
      .notNull()
      .references(() => users.id),
    enabledAt: ts(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.alias] }),
    uniqueIndex("team_models_default_idx")
      .on(t.teamId)
      .where(sql`${t.isDefault}`),
  ],
);

/**
 * Team table: the Bifrost virtual key of each (team, member), written by the server's gateway
 * sync and read by the model-gateway shim. The value is sealed with the virtual-key secret (shared
 * by the server and the shim only; AAD bound to team and user).
 */
export const modelGatewayKeys = pgTable(
  "model_gateway_keys",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Bifrost's id of the virtual key. */
    vkId: text().notNull(),
    vkValueEnc: text().notNull(),
    updatedAt: ts(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    check("model_gateway_keys_vk_id", sql`char_length(${t.vkId}) BETWEEN 1 AND 128`),
  ],
);

/**
 * Install-wide (†), one row: gateway sync progress. Every committed admin change bumps
 * `desired_version`; the sync records the version a successful pass applied, so "Bifrost reflects
 * every change" is `synced_version >= desired_version` (admin status, e2e).
 */
export const modelGatewayState = pgTable(
  "model_gateway_state",
  {
    id: smallint().primaryKey().default(1),
    desiredVersion: bigint({ mode: "number" }).notNull().default(1),
    syncedVersion: bigint({ mode: "number" }).notNull().default(0),
    lastAttemptAt: timestamp({ withTimezone: true }),
    lastSyncedAt: timestamp({ withTimezone: true }),
    /** Machine-readable failure of the last pass (null after a success); never a message. */
    lastError: text(),
  },
  (t) => [
    check("model_gateway_state_singleton", sql`${t.id} = 1`),
    check(
      "model_gateway_state_error",
      sql`${t.lastError} IS NULL OR ${t.lastError} ~ '^[a-z0-9_]{1,64}$'`,
    ),
  ],
);
