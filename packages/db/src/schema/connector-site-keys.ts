import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { CONNECTOR_GRANT_HINT_MAX, CONNECTOR_GRANT_SEALED_MAX } from "./connector-grants.js";
import { connectors } from "./connectors.js";

/**
 * Site-wide (†): one API key for an `api_key` connector whose `credential_source` is `site`
 * (KOBE-303). Every member of a team that enabled the connector calls it with this key instead of
 * their own. Like `connector_grants`, the key is stored only as KOBE-107 envelope text
 * (`e1.<kid>...`, bound to the connector), never plaintext, and no API returns it: the registry
 * shows `hint`. No team data; deleting the connector deletes its key.
 */
export const connectorSiteKeys = pgTable(
  "connector_site_keys",
  {
    connectorId: uuid()
      .primaryKey()
      .references(() => connectors.id, { onDelete: "cascade" }),
    /** KOBE-107 envelope text (`e1.` prefix); the plaintext never reaches Postgres. */
    sealed: text().notNull(),
    /** KEK id of `sealed` (`Envelope.keyIdOf`), so a rotation sweep can find stale rows. */
    keyId: text().notNull(),
    /** Masked display hint (last four characters of a long key at most). */
    hint: text().notNull(),
    /** The site admin who last set it. */
    updatedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "connector_site_keys_sealed",
      sql`${t.sealed} ~ '^e1\\.[A-Za-z0-9_.-]+$' AND char_length(${t.sealed}) <= ${sql.raw(String(CONNECTOR_GRANT_SEALED_MAX))}`,
    ),
    check("connector_site_keys_key_id", sql`char_length(${t.keyId}) BETWEEN 1 AND 64`),
    check(
      "connector_site_keys_hint",
      sql`char_length(${t.hint}) <= ${sql.raw(String(CONNECTOR_GRANT_HINT_MAX))}`,
    ),
  ],
);
