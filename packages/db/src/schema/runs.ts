import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { threads } from "./threads.js";

export const runTrigger = pgEnum("run_trigger", ["user", "schedule"]);
export type RunTrigger = (typeof runTrigger.enumValues)[number];

export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "budget_stopped",
]);
export type RunStatus = (typeof runStatus.enumValues)[number];

/** A run that holds its thread: at most one per thread (D17). */
export const ACTIVE_RUN_STATUSES = ["running", "waiting_approval"] as const satisfies RunStatus[];

/** A run that has ended; exactly these carry `ended_at`. */
export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "budget_stopped",
] as const satisfies RunStatus[];

const statusList = (statuses: readonly RunStatus[]) =>
  sql.raw(statuses.map((s) => `'${s}'`).join(", "));

/**
 * One agent turn on a thread (D16, D17). Queued runs wait in `queue_pos` order; one active run per
 * thread is enforced here as well as by the orchestrator's advisory lock.
 */
export const runs = pgTable(
  "runs",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    threadId: uuid().notNull(),
    trigger: runTrigger().notNull(),
    status: runStatus().notNull().default("queued"),
    queuePos: integer(),
    startedAt: timestamp({ withTimezone: true }),
    endedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Last allocated `run_events.seq`; maintained by a trigger, never written by the app. */
    lastSeq: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "runs_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    index("runs_thread_idx").on(t.teamId, t.threadId, t.createdAt),
    uniqueIndex("runs_one_active_per_thread")
      .on(t.teamId, t.threadId)
      .where(sql`${t.status} IN (${statusList(ACTIVE_RUN_STATUSES)})`),
    // Compaction of ended runs' events after 7 days (D18).
    index("runs_ended_idx")
      .on(t.teamId, t.endedAt)
      .where(sql`${t.endedAt} IS NOT NULL`),
    check(
      "runs_ended_at",
      sql`(${t.status} IN (${statusList(TERMINAL_RUN_STATUSES)})) = (${t.endedAt} IS NOT NULL)`,
    ),
    check(
      "runs_started_at",
      sql`${t.status} NOT IN (${statusList(ACTIVE_RUN_STATUSES)}) OR ${t.startedAt} IS NOT NULL`,
    ),
    check("runs_queue_pos", sql`${t.queuePos} IS NULL OR ${t.status} = 'queued'`),
    check("runs_last_seq", sql`${t.lastSeq} >= 0`),
  ],
);

/**
 * The live Kobe Event Stream (D16, §6.2), written before fan-out. `seq` is assigned by a trigger
 * that increments `runs.last_seq` under the run's row lock: gapless, monotonic per run, and
 * committed in seq order, so a reader resuming after seq n never skips an event. `type` is the
 * event type from `@kobe/protocol` (validated there; text here so new types need no migration).
 */
export const runEvents = pgTable(
  "run_events",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    runId: uuid().notNull(),
    seq: integer().notNull().default(0),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.runId, t.seq] }),
    foreignKey({
      name: "run_events_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [runs.teamId, runs.id],
    }).onDelete("cascade"),
    check("run_events_seq_positive", sql`${t.seq} > 0`),
    check("run_events_type_format", sql`${t.type} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$'`),
  ],
);
