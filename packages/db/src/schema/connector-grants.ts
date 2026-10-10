import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { connectors } from "./connectors.js";
import { teams } from "./teams.js";

// Per-user connector grants (KOBE-108, 61b of KOBE-61): the API key a user supplies for an
// `api_key` connector their team enabled. Team table. The secret is stored only as the KOBE-107
// envelope text (`e1.<kid>....`, AAD-bound to team, kind and record), never as plaintext, and no
// API returns it: the app reads `hint` and the timestamps. OAuth grants (KOBE-109) reuse the
// table with `kind = 'oauth'`.

/**
 * `api_key`: one static secret. `oauth` (KOBE-109): a sealed JSON bundle of access token, refresh
 * token and client details; `expires_at` is the access token's expiry (KOBE-110 refreshes).
 */
export const CONNECTOR_GRANT_KIND_VALUES = ["api_key", "oauth"] as const;
export type ConnectorGrantKind = (typeof CONNECTOR_GRANT_KIND_VALUES)[number];

/** Longest masked hint stored (e.g. "••••abcd"). */
export const CONNECTOR_GRANT_HINT_MAX = 16;
/** Longest sealed envelope text stored (a key of a few KB, wrapped, base64url). */
export const CONNECTOR_GRANT_SEALED_MAX = 16384;

export const connectorGrants = pgTable(
  "connector_grants",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** The grant's owner: only this user's runs ever get it attached. */
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectorId: uuid()
      .notNull()
      .references(() => connectors.id, { onDelete: "cascade" }),
    kind: text().$type<ConnectorGrantKind>().notNull().default("api_key"),
    /** KOBE-107 envelope text (`e1.` prefix); the plaintext never reaches Postgres. */
    sealed: text().notNull(),
    /** KEK id of `sealed` (`Envelope.keyIdOf`), so a rotation sweep can find stale rows. */
    keyId: text().notNull(),
    /** Masked display hint (last characters only), safe to show the owner. */
    hint: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Access-token expiry for `oauth` grants (null for API keys); not secret. */
    expiresAt: timestamp({ withTimezone: true }),
    /** Set when the key is replaced. */
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId, t.connectorId] }),
    index("connector_grants_connector_idx").on(t.teamId, t.connectorId),
    check("connector_grants_kind", sql`${t.kind} IN ('api_key', 'oauth')`),
    check(
      "connector_grants_sealed",
      sql`${t.sealed} ~ '^e1\\.[A-Za-z0-9_.-]+$' AND char_length(${t.sealed}) <= ${sql.raw(String(CONNECTOR_GRANT_SEALED_MAX))}`,
    ),
    check("connector_grants_key_id", sql`char_length(${t.keyId}) BETWEEN 1 AND 64`),
    check(
      "connector_grants_hint",
      sql`char_length(${t.hint}) <= ${sql.raw(String(CONNECTOR_GRANT_HINT_MAX))}`,
    ),
  ],
);
