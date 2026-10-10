import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Web search provider setting (KOBE-113, 63a of KOBE-63). The install admin picks one provider and
// stores its API key (`web_search_settings`, install-wide, one row); a team admin then opts the
// team in (`team_web_search`, a team table). The `web_search` tool itself is KOBE-114.

/** Providers Kobe can call. The egress ceiling gets the provider's API domain when enabled. */
export const WEB_SEARCH_PROVIDER_VALUES = ["brave", "tavily", "exa"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDER_VALUES)[number];

/** Longest masked hint stored (e.g. "••••abcd"). */
export const WEB_SEARCH_HINT_MAX = 16;
/** Longest sealed envelope text stored. */
export const WEB_SEARCH_SEALED_MAX = 16384;

/**
 * Install-wide (†): the single web-search provider and its key. Exactly one row may exist (`id`
 * is pinned to 1); no row means web search is not configured. The key is stored only as the
 * KOBE-107 envelope text (`e1.<kid>...`), never plaintext, and no API returns it: the app reads
 * `hint`. No team data.
 */
export const webSearchSettings = pgTable(
  "web_search_settings",
  {
    id: integer().primaryKey().default(1),
    provider: text().$type<WebSearchProvider>().notNull(),
    /** Master switch: when false the provider is configured but no team may use it. */
    enabled: boolean().notNull().default(true),
    /** KOBE-107 envelope text (`e1.` prefix); the plaintext never reaches Postgres. */
    sealed: text().notNull(),
    /** KEK id of `sealed` (`Envelope.keyIdOf`), so a rotation sweep can find stale rows. */
    keyId: text().notNull(),
    /** Masked display hint (last characters only), safe to show an install admin. */
    hint: text().notNull(),
    updatedBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("web_search_settings_singleton", sql`${t.id} = 1`),
    check("web_search_settings_provider", sql`${t.provider} IN ('brave', 'tavily', 'exa')`),
    check(
      "web_search_settings_sealed",
      sql`${t.sealed} ~ '^e1\\.[A-Za-z0-9_.-]+$' AND char_length(${t.sealed}) <= ${sql.raw(String(WEB_SEARCH_SEALED_MAX))}`,
    ),
    check("web_search_settings_key_id", sql`char_length(${t.keyId}) BETWEEN 1 AND 64`),
    check(
      "web_search_settings_hint",
      sql`char_length(${t.hint}) <= ${sql.raw(String(WEB_SEARCH_HINT_MAX))}`,
    ),
  ],
);

/** Team table: the team opted in to web search (a row means enabled). */
export const teamWebSearch = pgTable("team_web_search", {
  teamId: uuid()
    .primaryKey()
    .references(() => teams.id, { onDelete: "cascade" }),
  enabledBy: uuid()
    .notNull()
    .references(() => users.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
