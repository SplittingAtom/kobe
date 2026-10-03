import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { runs } from "./runs.js";
import { teams } from "./teams.js";
import { threads } from "./threads.js";

// Sandbox connection registry and routing (KOBE-24, spec D13). A sandbox (one per user and team,
// D11) holds one WebSocket to one server replica; any replica may route a command to it. Postgres
// is the record (these tables), LISTEN/NOTIFY only a hint that carries ids. Team tables: every key
// and foreign key includes team_id (KOBE-29 convention).

const teamRef = () =>
  uuid()
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" });

/**
 * The latest wire connection of each (team, user) sandbox. A new connection replaces the row (and
 * the replica holding the old socket closes it with `replaced`); `closed_at` is set on disconnect
 * and kept, so the lost-sandbox sweep can measure the grace period. `last_seen_at` is refreshed by
 * the holding replica's heartbeat: a stale row means that replica died with the socket.
 */
export const sandboxConnections = pgTable(
  "sandbox_connections",
  {
    teamId: teamRef(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** agent-sandbox claim UID (session token `sub`, KOBE-22). */
    sandboxId: uuid().notNull(),
    connectionId: uuid().notNull(),
    /** Random id of the server process holding the socket (its NOTIFY address). */
    replicaId: text().notNull(),
    connectedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    check("sandbox_connections_replica_id", sql`char_length(${t.replicaId}) BETWEEN 1 AND 64`),
  ],
);

export const sandboxCommandStatus = pgEnum("sandbox_command_status", [
  "pending", // waiting for the sandbox's connection
  "delivered", // sent on `connection_id`, no `command.result` yet
  "done", // command.result ok
  "failed", // command.result error, expired, or lost with its connection
]);
export type SandboxCommandStatus = (typeof sandboxCommandStatus.enumValues)[number];

export const SANDBOX_COMMAND_KINDS = ["run.start", "run.steer", "run.stop", "pi.command"] as const;
export type SandboxCommandKind = (typeof SANDBOX_COMMAND_KINDS)[number];

/**
 * Server → sandbox commands in flight. The requesting replica inserts the row (the frame without
 * its wire `command_id`, which is minted per connection when sent), the replica holding the socket
 * delivers it and records the result, and the requester reads and deletes it. Rows carry message
 * content, so they are short-lived: deleted once consumed, expired by `expires_at`.
 */
export const sandboxCommands = pgTable(
  "sandbox_commands",
  {
    teamId: teamRef(),
    id: uuid().notNull().defaultRandom(),
    userId: uuid().notNull(),
    threadId: uuid().notNull(),
    runId: uuid(),
    kind: text().$type<SandboxCommandKind>().notNull(),
    frame: jsonb().$type<Record<string, unknown>>().notNull(),
    status: sandboxCommandStatus().notNull().default("pending"),
    connectionId: uuid(),
    requesterReplica: text().notNull(),
    result: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "sandbox_commands_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    // Delivery order per sandbox (pending first) and the expiry sweep.
    index("sandbox_commands_open_idx")
      .on(t.teamId, t.userId, t.createdAt)
      .where(sql`${t.status} IN ('pending', 'delivered')`),
    index("sandbox_commands_expiry_idx").on(t.teamId, t.expiresAt),
    check(
      "sandbox_commands_kind",
      sql`${t.kind} IN (${sql.raw(SANDBOX_COMMAND_KINDS.map((k) => `'${k}'`).join(", "))})`,
    ),
    check("sandbox_commands_requester", sql`char_length(${t.requesterReplica}) BETWEEN 1 AND 64`),
    check("sandbox_commands_frame_object", sql`jsonb_typeof(${t.frame}) = 'object'`),
    check(
      "sandbox_commands_delivered",
      sql`${t.status} = 'pending' OR ${t.status} = 'failed' OR ${t.connectionId} IS NOT NULL`,
    ),
  ],
);

/**
 * Which sandbox a run was started on (written when its `run.start` is delivered). Leases are the
 * wire's authority: inbound frames may name only runs leased to the (team, user) sandbox of their
 * connection, `hello.ack` lists the active ones, and the lost-sandbox sweep interrupts active runs
 * whose sandbox has been gone longer than the grace period (D14).
 */
export const sandboxRunLeases = pgTable(
  "sandbox_run_leases",
  {
    teamId: teamRef(),
    runId: uuid().notNull(),
    userId: uuid().notNull(),
    threadId: uuid().notNull(),
    sandboxId: uuid().notNull(),
    leasedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.runId] }),
    foreignKey({
      name: "sandbox_run_leases_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [runs.teamId, runs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "sandbox_run_leases_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    index("sandbox_run_leases_user_idx").on(t.teamId, t.userId),
  ],
);
