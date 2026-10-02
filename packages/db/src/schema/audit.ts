import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  inet,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Who did it (spec §5.4 `actor_kind: user|agent|system`). `user` with a null actor id is an
 * unauthenticated attempt (e.g. a failed sign-in).
 */
export const auditActorKind = pgEnum("audit_actor_kind", ["user", "agent", "system"]);
export type AuditActorKind = (typeof auditActorKind.enumValues)[number];

/**
 * Install-wide append-only audit log (spec D6, D31, §5.4 `audit_log†`). One row per audited action,
 * written with `audit()` in the same transaction as the action. Metadata only: `target` holds the
 * per-action allowlisted fields of `AUDIT_EVENTS`, never secrets, tokens or content.
 *
 * Append-only in Postgres (migration `audit_log_append_only`): the app role holds INSERT and SELECT
 * only, triggers refuse UPDATE, DELETE and TRUNCATE for every non-superuser role, and a BEFORE
 * INSERT trigger assigns `seq`, `at`, `prev_hash` and `hash` under a transaction-scoped advisory
 * lock, so rows form a gapless SHA-256 hash chain in commit order. Rows carry no foreign keys: an
 * audit record outlives what it describes and loads in any order on restore.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    /** Chain position: gapless, from 1, assigned by the database (send 0 / omit). Keyset cursor. */
    seq: bigint({ mode: "number" }).primaryKey().default(0),
    /** Stable event id (export and SIEM de-duplication). */
    id: uuid().notNull().unique().defaultRandom(),
    /** Assigned by the database under the chain lock, so `at` never decreases along `seq`. */
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** The team the event belongs to (team audit view); null for install-level events. */
    teamId: uuid(),
    actorKind: auditActorKind().notNull(),
    /** User or agent id; null for system events and unauthenticated attempts. */
    actorId: uuid(),
    /** Dotted event name from `AUDIT_EVENTS`, e.g. `identity.member.role_changed`. */
    action: text().notNull(),
    /** First segment of `action` (`auth`, `identity`, …), stored so category filters use an index. */
    category: text()
      .notNull()
      .generatedAlwaysAs(sql`split_part(action, '.', 1)`),
    /** Allowlisted metadata of the action (ids, enums, short labels). */
    target: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** Client address of the request, when there was one. */
    ip: inet(),
    userAgent: text(),
    /** Hex SHA-256 of the previous row (64 zeros for seq 1). */
    prevHash: text().notNull().default(""),
    /** Hex SHA-256 over `prev_hash` and this row's canonical form (`audit_log_canonical`). */
    hash: text().notNull().default(""),
  },
  (t) => [
    index("audit_log_team_seq_idx")
      .on(t.teamId, t.seq)
      .where(sql`${t.teamId} IS NOT NULL`),
    index("audit_log_actor_seq_idx").on(t.actorId, t.seq),
    index("audit_log_action_seq_idx").on(t.action, t.seq),
    index("audit_log_category_seq_idx").on(t.category, t.seq),
    index("audit_log_at_idx").on(t.at),
    check("audit_log_action_format", sql`${t.action} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*){1,3}$'`),
    check("audit_log_action_length", sql`char_length(${t.action}) <= 64`),
    check("audit_log_target_object", sql`jsonb_typeof(${t.target}) = 'object'`),
    check("audit_log_target_size", sql`octet_length(${t.target}::text) <= 4096`),
    check("audit_log_user_agent_length", sql`char_length(${t.userAgent}) <= 256`),
    check("audit_log_system_actor", sql`${t.actorKind} <> 'system' OR ${t.actorId} IS NULL`),
  ],
);
