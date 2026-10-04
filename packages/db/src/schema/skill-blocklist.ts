import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

// Install-wide skill blocklist (KOBE-81, spec D22): SHA-256 hashes of canonical skill bundles
// (`skill_*_versions.content_hash`, KOBE-78) that never load anywhere in the install. Install admins
// manage it; the server reads it on every upload, review decision and run start (never cached).
// Rows are only added or removed, never edited.

/** Lowercase hex SHA-256, as stored in `content_hash`. */
export const SKILL_HASH_SQL = "^[0-9a-f]{64}$";
export const SKILL_BLOCK_REASON_MAX = 500;

export const skillBlocklist = pgTable(
  "skill_blocklist",
  {
    contentHash: text().primaryKey(),
    reason: text().notNull(),
    // Users are deactivated, never deleted (NO ACTION).
    addedBy: uuid()
      .notNull()
      .references(() => users.id),
    addedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The paged admin list: newest first.
    index("skill_blocklist_added_idx").on(t.addedAt.desc(), t.contentHash),
    check("skill_blocklist_hash", sql`${t.contentHash} ~ ${sql.raw(`'${SKILL_HASH_SQL}'`)}`),
    check(
      "skill_blocklist_reason",
      sql`char_length(btrim(${t.reason})) BETWEEN 1 AND ${sql.raw(String(SKILL_BLOCK_REASON_MAX))}`,
    ),
  ],
);
