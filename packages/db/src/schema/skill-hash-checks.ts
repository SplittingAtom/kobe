import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { SKILL_HASH_SQL } from "./skill-blocklist.js";

// Site-wide (†): what each stored skill hash is under the KOBE-309 package contract (KOBE-310,
// docs/skill-package.md "Identity"). One row per distinct stored `content_hash`, written once by
// the recompute (or at upload for new versions) and never changed:
//   - runtime_hash = stored_hash: the stored zip is its own runtime payload (every new version);
//   - runtime_hash <> stored_hash: an alias; the stored zip held `evals/` or `kobe.skill.yaml`.
//     Many stored hashes can share one runtime hash: together they are one blocklist identity;
//   - runtime_hash NULL with `problems`: legacy, refused by today's path rules; its stored hash
//     stays its only identity and it is never promotable or exportable until re-saved.
// Hashes only (no names, paths or teams), so the table can be site-wide.
export const skillHashChecks = pgTable(
  "skill_hash_checks",
  {
    storedHash: text().primaryKey(),
    runtimeHash: text(),
    /** Contract problem codes (`checkPackagePaths`) that make the stored version legacy. */
    problems: jsonb().$type<string[]>().notNull().default([]),
    checkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("skill_hash_checks_runtime_idx").on(t.runtimeHash),
    check(
      "skill_hash_checks_stored_hash",
      sql`${t.storedHash} ~ ${sql.raw(`'${SKILL_HASH_SQL}'`)}`,
    ),
    check(
      "skill_hash_checks_runtime_hash",
      sql`${t.runtimeHash} IS NULL OR ${t.runtimeHash} ~ ${sql.raw(`'${SKILL_HASH_SQL}'`)}`,
    ),
    check(
      "skill_hash_checks_outcome",
      sql`jsonb_typeof(${t.problems}) = 'array' AND (${t.runtimeHash} IS NULL) = (jsonb_array_length(${t.problems}) > 0)`,
    ),
  ],
);
