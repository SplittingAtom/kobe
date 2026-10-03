import { sql } from "drizzle-orm";
import { boolean, check, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Egress allowlists (spec D6, D28, §5.4). Install admins define the **ceiling** (`egress_domains`,
// install-wide); team admins **enable** domains within it (`team_egress`, a team table). A sandbox
// may open a connection to a host only if its team enabled a pattern that matches the host and that
// pattern is in the ceiling. Patterns are lowercase ASCII (IDNA) host names, optionally `*.` + name
// (subdomains only, never the apex); `packages/db/src/egress/domain.ts` validates and matches them.

/** Same grammar as `parseDomainPattern` (domain.ts); the database refuses anything else. */
export const DOMAIN_PATTERN_SQL =
  "^(\\*\\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$";

/** Preset groups (D28). The web-search provider's domain is added by KOBE-63 ("auto"). */
export const EGRESS_PRESETS = ["package_registries", "git_hosts", "web_search"] as const;
export type EgressPreset = (typeof EGRESS_PRESETS)[number];

const patternCheck = (column: unknown) =>
  sql`char_length(${column}) <= 253 AND ${column} ~ ${sql.raw(`'${DOMAIN_PATTERN_SQL}'`)}`;

/**
 * Install-wide (†): every domain pattern the install knows, preset or custom. `in_ceiling` says
 * whether teams may enable it; preset rows stay listed when taken out of the ceiling, custom rows
 * are deleted (which removes every team's enablement of it with them).
 */
export const egressDomains = pgTable(
  "egress_domains",
  {
    domain: text().primaryKey(),
    /** Preset group, or null for a domain an install admin added. */
    preset: text().$type<EgressPreset>(),
    inCeiling: boolean().notNull().default(false),
    note: text(),
    /** Null for presets seeded by the migration. */
    createdBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("egress_domains_domain", patternCheck(t.domain)),
    check(
      "egress_domains_preset",
      sql`${t.preset} IS NULL OR ${t.preset} IN (${sql.raw(EGRESS_PRESETS.map((p) => `'${p}'`).join(", "))})`,
    ),
    check("egress_domains_note", sql`${t.note} IS NULL OR char_length(${t.note}) <= 200`),
  ],
);

/**
 * Team table: the ceiling domains a team enabled for its sandboxes. Only effective while the
 * domain is `in_ceiling`; rows survive a preset leaving the ceiling (so re-adding it restores the
 * team's choice) and go away with a deleted custom domain. KOBE-39 adds per-team header injection.
 */
export const teamEgress = pgTable(
  "team_egress",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    domain: text()
      .notNull()
      .references(() => egressDomains.domain, { onDelete: "cascade" }),
    enabledBy: uuid()
      .notNull()
      .references(() => users.id),
    enabledAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.domain] })],
);
