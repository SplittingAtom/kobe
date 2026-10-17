import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agentScope } from "./agents.js";
import { users } from "./auth.js";
import { runs } from "./runs.js";
import { teams } from "./teams.js";
import { threadEntries, threads } from "./threads.js";

// Answer feedback (KOBE-275): a member's thumbs up or down on one answer (one message run). A team
// table keyed like everything a thread owns: every foreign key includes team_id, and the rows go
// with their run and thread (retention, Trash purge, Delete forever, team delete). RLS, the
// break-glass read policy and the legal-hold guards are SQL-only (custom migration
// `*_answer_feedback_rls.sql`).

/** `@kobe/protocol` FEEDBACK_RATINGS. */
export const ANSWER_FEEDBACK_RATINGS = ["up", "down"] as const;
export type AnswerFeedbackRating = (typeof ANSWER_FEEDBACK_RATINGS)[number];

/** `@kobe/protocol` FEEDBACK_REASONS. */
export const ANSWER_FEEDBACK_REASONS = [
  "wrong",
  "ignored_instructions",
  "unsafe",
  "too_slow",
  "other",
] as const;
export type AnswerFeedbackReason = (typeof ANSWER_FEEDBACK_REASONS)[number];

/** `@kobe/protocol` FEEDBACK_COMMENT_MAX_CHARS. */
export const ANSWER_FEEDBACK_COMMENT_MAX_CHARS = 500;
/** Longest model alias kept (the run's catalog alias). */
export const ANSWER_FEEDBACK_MODEL_MAX_CHARS = 240;

const textList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/**
 * One member's rating of one answer: one row per (run, member). `user_id` is the rater, who may be
 * the thread's owner or a reader of a shared thread (KOBE-221); nobody else reads the row through
 * the API, and the comment is shown to its author only.
 *
 * `agent_scope` / `agent_id` / `agent_version` / `model_alias` are a snapshot taken at the first
 * rating, from the run's `run.started` event (the version and model the run actually used), or the
 * thread's pin once the run's events were compacted (D18); no foreign key, so they stay when the
 * agent or alias goes. They feed the owners' per-version totals, which never read `comment`.
 *
 * `id` is stable while the rating exists (changes keep it; clearing deletes the row): the Langfuse
 * score's id, and what an eval case shared from this rating (KOBE-276) refers to.
 */
export const answerFeedback = pgTable(
  "answer_feedback",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    threadId: uuid().notNull(),
    runId: uuid().notNull(),
    /** The answer's last entry the member saw (optional): an entry of `thread_id`. */
    entryId: text(),
    // Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing ratings.
    userId: uuid()
      .notNull()
      .references(() => users.id),
    rating: text().$type<AnswerFeedbackRating>().notNull(),
    reasons: text()
      .array()
      .$type<AnswerFeedbackReason[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    comment: text(),
    agentScope: agentScope(),
    agentId: uuid(),
    agentVersion: integer(),
    modelAlias: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    unique("answer_feedback_run_user_unique").on(t.teamId, t.runId, t.userId),
    foreignKey({
      name: "answer_feedback_run_fk",
      columns: [t.teamId, t.runId],
      foreignColumns: [runs.teamId, runs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "answer_feedback_thread_fk",
      columns: [t.teamId, t.threadId],
      foreignColumns: [threads.teamId, threads.id],
    }).onDelete("cascade"),
    // MATCH SIMPLE: no check while entry_id is null.
    foreignKey({
      name: "answer_feedback_entry_fk",
      columns: [t.teamId, t.threadId, t.entryId],
      foreignColumns: [threadEntries.teamId, threadEntries.threadId, threadEntries.entryId],
    }).onDelete("cascade"),
    // The member's ratings in a thread (the chat), and the thread and entry keys' delete checks.
    index("answer_feedback_thread_user_idx").on(t.teamId, t.threadId, t.userId),
    // Per-version totals of an agent over a time range (owners' quality view).
    index("answer_feedback_agent_idx")
      .on(t.teamId, t.agentId, t.updatedAt)
      .where(sql`${t.agentId} IS NOT NULL`),
    check("answer_feedback_rating", sql`${t.rating} IN (${textList(ANSWER_FEEDBACK_RATINGS)})`),
    check(
      "answer_feedback_reasons",
      sql`${t.reasons} <@ ARRAY[${textList(ANSWER_FEEDBACK_REASONS)}]::text[] AND cardinality(${t.reasons}) <= ${sql.raw(String(ANSWER_FEEDBACK_REASONS.length))} AND array_position(${t.reasons}, NULL) IS NULL`,
    ),
    check(
      "answer_feedback_comment",
      sql`${t.comment} IS NULL OR char_length(${t.comment}) BETWEEN 1 AND ${sql.raw(String(ANSWER_FEEDBACK_COMMENT_MAX_CHARS))}`,
    ),
    // Reasons and a comment belong to a thumbs down only.
    check(
      "answer_feedback_down_only",
      sql`${t.rating} = 'down' OR (cardinality(${t.reasons}) = 0 AND ${t.comment} IS NULL)`,
    ),
    check(
      "answer_feedback_agent",
      sql`(${t.agentId} IS NULL) = (${t.agentScope} IS NULL) AND (${t.agentVersion} IS NULL OR (${t.agentId} IS NOT NULL AND ${t.agentVersion} > 0))`,
    ),
    check(
      "answer_feedback_model_alias",
      sql`${t.modelAlias} IS NULL OR char_length(${t.modelAlias}) BETWEEN 1 AND ${sql.raw(String(ANSWER_FEEDBACK_MODEL_MAX_CHARS))}`,
    ),
    check(
      "answer_feedback_entry_id",
      sql`${t.entryId} IS NULL OR char_length(${t.entryId}) BETWEEN 1 AND 128`,
    ),
    check("answer_feedback_updated_at", sql`${t.updatedAt} >= ${t.createdAt}`),
  ],
);
