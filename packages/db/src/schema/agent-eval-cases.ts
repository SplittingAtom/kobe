import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agentScope } from "./agents.js";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Shared eval cases (KOBE-276): a member's consented copy of one rated-down exchange, owned by the
// agent (team table, RLS). Not thread content: no key into threads, runs or entries, so the case
// survives the thread and reading it never reads the thread. RLS, the break-glass read policy, the
// rating key (ON DELETE SET NULL (feedback_id), which drizzle can't express), the immutability and
// the legal-hold triggers are SQL-only (custom migration `*_agent_eval_cases_rls.sql`).

/** `@kobe/protocol` EVAL_CASE_STATUSES. */
export const AGENT_EVAL_CASE_STATUSES = ["open", "accepted", "dismissed"] as const;
export type AgentEvalCaseStatus = (typeof AGENT_EVAL_CASE_STATUSES)[number];

/** `@kobe/protocol` EVAL_CASE_EXPECTED_MAX_CHARS. */
export const AGENT_EVAL_CASE_EXPECTED_MAX_CHARS = 2_000;
/** Ceiling on a stored copy (its jsonb text), well above what the server's limits produce. */
export const AGENT_EVAL_CASE_CONTENT_MAX_BYTES = 128 * 1024;

const textList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

/**
 * One shared case. `user_id` is the member who shared it (the conversation's owner): the only one
 * who lists or withdraws it, and whose legal hold covers it; never shown to the agent's owner.
 * `feedback_id` is the rating it was shared from while that rating exists (a SQL-only key with
 * ON DELETE SET NULL (feedback_id)): one case per rating; a cleared rating leaves the case.
 *
 * `agent_*` name the agent and version that answered (from the rating's snapshot; no key, like
 * answer_feedback's). `content` is the copy (`@kobe/protocol` EvalCaseContent), immutable with the
 * identity columns; only the review (`status`, `expected_behaviour`, `reviewed_at`) changes.
 * Accepted cases need an expected behaviour; they run in the agent's pre-publish eval (KOBE-93).
 */
export const agentEvalCases = pgTable(
  "agent_eval_cases",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    feedbackId: uuid(),
    // Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing cases.
    userId: uuid()
      .notNull()
      .references(() => users.id),
    agentScope: agentScope().notNull(),
    agentId: uuid().notNull(),
    agentVersion: integer(),
    content: jsonb().$type<Record<string, unknown>>().notNull(),
    status: text().$type<AgentEvalCaseStatus>().notNull().default("open"),
    expectedBehaviour: text(),
    reviewedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    // One case per rating; also the rating key's delete check.
    unique("agent_eval_cases_feedback_unique").on(t.teamId, t.feedbackId),
    // The owner's review list and the eval gate's accepted set.
    index("agent_eval_cases_agent_idx").on(t.teamId, t.agentId, t.status, t.createdAt),
    // The member's own cases (list, export, offboarding).
    index("agent_eval_cases_user_idx").on(t.teamId, t.userId, t.createdAt),
    // Retention by age (KOBE-276 review N2).
    index("agent_eval_cases_created_idx").on(t.teamId, t.createdAt),
    check("agent_eval_cases_scope", sql`${t.agentScope} IN ('team', 'personal')`),
    check("agent_eval_cases_status", sql`${t.status} IN (${textList(AGENT_EVAL_CASE_STATUSES)})`),
    check("agent_eval_cases_version", sql`${t.agentVersion} IS NULL OR ${t.agentVersion} > 0`),
    check(
      "agent_eval_cases_content",
      sql`jsonb_typeof(${t.content}) = 'object' AND octet_length(${t.content}::text) <= ${sql.raw(String(AGENT_EVAL_CASE_CONTENT_MAX_BYTES))}`,
    ),
    check(
      "agent_eval_cases_expected",
      sql`${t.expectedBehaviour} IS NULL OR char_length(${t.expectedBehaviour}) BETWEEN 1 AND ${sql.raw(String(AGENT_EVAL_CASE_EXPECTED_MAX_CHARS))}`,
    ),
    // An accepted case says what it expects; a reviewed one says when.
    check(
      "agent_eval_cases_accepted",
      sql`${t.status} <> 'accepted' OR ${t.expectedBehaviour} IS NOT NULL`,
    ),
    check("agent_eval_cases_reviewed", sql`${t.status} = 'open' OR ${t.reviewedAt} IS NOT NULL`),
  ],
);

/**
 * A legal hold's copy of a case (the KOBE-275 history pattern): when a case is deleted (the member
 * withdraws it) while a hold covers the member, a trigger copies it here and the withdrawal goes
 * through as usual: a hold is never refused or otherwise visible. Written only by that trigger;
 * immutable; nothing in the API reads it (break-glass only). Deleting it is refused while a hold
 * covers the member; the retention pass purges it once none does.
 */
export const agentEvalCaseHistory = pgTable(
  "agent_eval_case_history",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    /** The case's id; no key: the case is gone. */
    caseId: uuid().notNull(),
    feedbackId: uuid(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    agentScope: agentScope().notNull(),
    agentId: uuid().notNull(),
    agentVersion: integer(),
    content: jsonb().$type<Record<string, unknown>>().notNull(),
    status: text().$type<AgentEvalCaseStatus>().notNull(),
    expectedBehaviour: text(),
    reviewedAt: timestamp({ withTimezone: true }),
    /** The case's own creation time. */
    sharedAt: timestamp({ withTimezone: true }).notNull(),
    keptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    // The release purge and a custodian's lookup by member.
    index("agent_eval_case_history_user_idx").on(t.teamId, t.userId),
    check(
      "agent_eval_case_history_status",
      sql`${t.status} IN (${textList(AGENT_EVAL_CASE_STATUSES)})`,
    ),
  ],
);
