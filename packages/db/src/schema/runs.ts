import { sql } from "drizzle-orm";
import {
  bigint,
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

/** Thread approval modes (D29; `@kobe/protocol` `APPROVAL_MODES`). There is no bypass mode. */
export const RUN_APPROVAL_MODES = ["ask-on-write", "ask-all", "auto"] as const;
export type RunApprovalMode = (typeof RUN_APPROVAL_MODES)[number];

/** Who a budget stop applies to (D30; `@kobe/protocol` `BudgetStopCommand.scope`). */
export const BUDGET_STOP_SCOPES = ["install", "team", "user"] as const;
export type BudgetStopScope = (typeof BUDGET_STOP_SCOPES)[number];

/** Longest message a run carries (`@kobe/protocol` `submitMessageBodySchema.content`). */
export const RUN_INPUT_MAX_CHARS = 200_000;

const textList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

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
    /**
     * Last allocated `run_events.seq`. Only the seq trigger may change it (by exactly 1); app writes
     * are rejected. Appenders lock this row until commit, so status writers (stop, interrupt,
     * approval) contend with them: keep both kinds of transaction short and set a `lock_timeout`
     * on status paths.
     */
    lastSeq: integer().notNull().default(0),
    /** Set by the D18 compaction job once this ended run's events are folded into entries. */
    eventsCompactedAt: timestamp({ withTimezone: true }),
    /**
     * Durable inbound sandbox-wire cursor (KOBE-24; `@kobe/protocol` sandbox-wire/connection.ts):
     * the highest `pi.event` seq of this run whose effects are committed. Advanced only by a
     * compare-and-set in the same transaction as the appended rows; never decreases (trigger).
     */
    sandboxSeq: integer().notNull().default(0),
    /**
     * Bytes of events and entries this run's sandbox has caused to be stored (KOBE-24), advanced
     * with `sandbox_seq`; the wire stops the run at its cap so a compromised sandbox can't grow the
     * database without bound.
     */
    sandboxBytes: bigint({ mode: "number" }).notNull().default(0),
    /**
     * The effective approval mode fixed when the run is created (KOBE-30; `@kobe/protocol`
     * `RunSnapshot.approval_mode`): the requested mode clamped to the install and team floors, so a
     * later change can't loosen a run. Scheduled runs are `auto` (D32). The policy check clamps it
     * to the floor again at call time (floors only tighten).
     */
    approvalMode: text().$type<RunApprovalMode>().notNull().default("ask-on-write"),
    /**
     * The message the run sends to Pi (KOBE-30): kept while queued (editable, D17) and for Retry
     * (D14), which re-sends it. Purged with the thread (D18).
     */
    input: text().notNull().default(""),
    /**
     * Branch point (Pi entry id) the run continues from (KOBE-30): the submitted
     * `parent_entry_id` (edit-and-regenerate), else the thread's leaf when the run started. A retry
     * reuses its original's, so it becomes a sibling branch and the interrupted one stays intact.
     */
    parentEntryId: text(),
    /** The Pi entry id of the prompt this run answered, once mirrored (KOBE-30). */
    userEntryId: text(),
    /** The interrupted run this run retries (D14; at most one retry per run, KOBE-26 contract). */
    retryOfRunId: uuid(),
    /**
     * A budget stop is pending (D30, KOBE-42): the run ends `budget_stopped` after its current step,
     * even when Pi then settles normally.
     */
    budgetStopScope: text().$type<BudgetStopScope>(),
    /**
     * A stop the sandbox still has to receive (KOBE-30): set in the transaction that ends (or
     * budget-stops) a run that may be running in Pi, cleared once a `run.stop` was answered. The
     * orchestrator's sweep re-sends it, so a replica crash after commit can't leave Pi running.
     */
    stopMode: text().$type<"abort" | "after_step">(),
    stopRequestedAt: timestamp({ withTimezone: true }),
    /** Client-supplied idempotency key of the message (KOBE-30), unique per thread. */
    clientKey: text(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    foreignKey({
      name: "runs_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    index("runs_thread_idx").on(t.teamId, t.threadId, t.createdAt),
    foreignKey({
      name: "runs_retry_of_fk",
      columns: [t.teamId, t.retryOfRunId],
      foreignColumns: [t.teamId, t.id],
    }),
    // At most one retry per run (KOBE-26 contract); a second retry returns the first.
    uniqueIndex("runs_client_key_unique")
      .on(t.teamId, t.threadId, t.clientKey)
      .where(sql`${t.clientKey} IS NOT NULL`),
    // Pending stops the sweep re-sends (few rows at any time).
    index("runs_stop_pending_idx")
      .on(t.teamId, t.stopRequestedAt)
      .where(sql`${t.stopMode} IS NOT NULL`),
    uniqueIndex("runs_retry_of_unique")
      .on(t.teamId, t.retryOfRunId)
      .where(sql`${t.retryOfRunId} IS NOT NULL`),
    uniqueIndex("runs_one_active_per_thread")
      .on(t.teamId, t.threadId)
      .where(sql`${t.status} IN (${statusList(ACTIVE_RUN_STATUSES)})`),
    // Queue order: one queued run per position; reorder by moving runs through free positions.
    uniqueIndex("runs_queue_pos_unique")
      .on(t.teamId, t.threadId, t.queuePos)
      .where(sql`${t.status} = 'queued'`),
    // D18: ended runs whose events are not yet compacted (7 days after ended_at). The marker keeps
    // each pass from rescanning runs it already compacted.
    index("runs_compaction_idx")
      .on(t.teamId, t.endedAt)
      .where(sql`${t.endedAt} IS NOT NULL AND ${t.eventsCompactedAt} IS NULL`),
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
    check("runs_sandbox_seq", sql`${t.sandboxSeq} >= 0`),
    check("runs_sandbox_bytes", sql`${t.sandboxBytes} >= 0`),
    check("runs_approval_mode", sql`${t.approvalMode} IN (${textList(RUN_APPROVAL_MODES)})`),
    check(
      "runs_input_length",
      sql`char_length(${t.input}) <= ${sql.raw(String(RUN_INPUT_MAX_CHARS))}`,
    ),
    check(
      "runs_entry_ids",
      sql`(${t.parentEntryId} IS NULL OR char_length(${t.parentEntryId}) BETWEEN 1 AND 128) AND (${t.userEntryId} IS NULL OR char_length(${t.userEntryId}) BETWEEN 1 AND 128)`,
    ),
    check(
      "runs_stop_mode",
      sql`(${t.stopMode} IS NULL) = (${t.stopRequestedAt} IS NULL) AND (${t.stopMode} IS NULL OR ${t.stopMode} IN ('abort', 'after_step'))`,
    ),
    check(
      "runs_client_key",
      sql`${t.clientKey} IS NULL OR char_length(${t.clientKey}) BETWEEN 1 AND 128`,
    ),
    check("runs_retry_not_self", sql`${t.retryOfRunId} IS NULL OR ${t.retryOfRunId} <> ${t.id}`),
    check(
      "runs_budget_stop_scope",
      sql`${t.budgetStopScope} IS NULL OR ${t.budgetStopScope} IN (${textList(BUDGET_STOP_SCOPES)})`,
    ),
    check(
      "runs_events_compacted_at",
      sql`${t.eventsCompactedAt} IS NULL OR ${t.endedAt} IS NOT NULL`,
    ),
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
