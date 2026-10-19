import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";
import { threads } from "./threads.js";

/**
 * Team table (KOBE-325, SK16): the wire connection of one skill-eval thread's ephemeral sandbox
 * (slot `e-<thread id>` on `sandbox_commands` / `sandbox_run_leases`). Kept apart from
 * `sandbox_connections`, whose (team, user) key the previous release's connect path upserts on,
 * so an eval sandbox never replaces, or is mistaken for, the member's own connection. Keyed by
 * its thread, a real foreign key (ON DELETE CASCADE). `user_id` is the thread's owner (the eval's
 * starter, whose identity the run uses): a SQL-only row trigger (`*_skill_evals_rls.sql`) refuses
 * a row whose thread is not an eval thread of that owner. Same lifecycle as a member connection:
 * replaced on reconnect, `closed_at` kept on disconnect, `last_seen_at` refreshed by the holding
 * replica's heartbeat.
 */
export const sandboxEvalConnections = pgTable(
  "sandbox_eval_connections",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    threadId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** agent-sandbox claim UID (session token `sub`). */
    sandboxId: uuid().notNull(),
    connectionId: uuid().notNull(),
    /** Random id of the server process holding the socket (its NOTIFY address). */
    replicaId: text().notNull(),
    connectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.threadId] }),
    foreignKey({
      name: "sandbox_eval_connections_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    // Offboarding closes a member's eval sandboxes; the sweeps join leases on the claim UID.
    index("sandbox_eval_connections_user_idx").on(t.teamId, t.userId),
    index("sandbox_eval_connections_sandbox_idx").on(t.teamId, t.sandboxId),
    check("sandbox_eval_connections_replica_id", sql`char_length(${t.replicaId}) BETWEEN 1 AND 64`),
  ],
);
