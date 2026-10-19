import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Model usage ledger (KOBE-43, spec D30, §5.4 `run_usage`). One row per model call that the
// model-gateway shim forwarded to Bifrost, written by the shim from the upstream response (never
// from the sandbox): tokens, model, latency and the cost at the catalog's prices of that moment.
// Attributed to the team, user and sandbox the session token proves; the run (and its thread and
// agent) only when the sandbox named an active run leased to it (`x-kobe-run-id`, advisory: a
// same-uid process may name a sibling run of the same sandbox, KOBE-41). No foreign key to runs or
// threads: the ledger outlives a purged thread (budgets count spend, not content).

/** Which API the call used (the shim's route kinds). */
export const USAGE_ROUTES = ["openai", "anthropic", "gemini"] as const;
export type UsageRoute = (typeof USAGE_ROUTES)[number];

/**
 * Where the token counts come from: the provider's own usage report, or the shim's estimate when
 * the response carried none (a stream cut short, a request without usage reporting). Estimates
 * are deliberately generous, so leaving usage out never makes a call cheaper.
 */
export const USAGE_SOURCES = ["reported", "estimated"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/**
 * What made the call (KOBE-234, CE18/CE21): `run` for a sandbox's call during a run (every row
 * before migration 0099), `title` / `followups` for the server's own post-run calls through the
 * gateway (`@kobe/protocol` server-call.ts). Server calls have no sandbox; they carry the run whose
 * completion triggered them (so thread and agent resolve as for run calls). Budgets count every
 * kind; per-run views and the context gauge read `run` rows only. Skill evals (KOBE-326, SK17):
 * `eval_judge` for the server's judge call after an eval execution's run (a server call, like
 * titles), and `eval` for an eval sandbox's own calls (a sandbox call, like `run`; written once
 * KOBE-327 bills eval runs apart, until then they are `run`). Migration 0148 widens the CHECKs.
 */
export const USAGE_KINDS = ["run", "title", "followups", "eval", "eval_judge"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/** Longest gateway model id kept (`<gateway provider>/<model>`). */
export const USAGE_MODEL_MAX_CHARS = 240;

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const runUsage = pgTable(
  "run_usage",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    /** When the call started. */
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Users are deactivated, never deleted; NO ACTION keeps a stray delete from erasing spend.
    userId: uuid()
      .notNull()
      .references(() => users.id),
    /** The calling sandbox (session token `sub`); null for a server call (`kind` not `run`). */
    sandboxId: uuid(),
    kind: text().$type<UsageKind>().notNull().default("run"),
    /** Attribution hints (see above): null when the call named no run. */
    runId: uuid(),
    threadId: uuid(),
    agentId: uuid(),
    route: text().$type<UsageRoute>().notNull(),
    /** `<gateway provider>/<model>` as the request named it. */
    model: text().notNull(),
    /** The HTTP status returned to the sandbox. */
    status: smallint().notNull(),
    /** Input tokens not read from a prompt cache. */
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    usageSource: text().$type<UsageSource>().notNull(),
    /** Dollars at the catalog's prices when the call was made; null when the model has none. */
    costUsd: numeric({ precision: 20, scale: 10, mode: "number" }),
    durationMs: integer().notNull(),
    /** Time to the upstream's response headers (first byte of a stream). */
    ttfbMs: integer(),
    /** The sandbox went away (or the upstream failed) before the response finished. */
    aborted: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    // Dashboards and budget periods: the team's calls by time, and per user.
    index("run_usage_team_at_idx").on(t.teamId, t.at),
    index("run_usage_user_at_idx").on(t.teamId, t.userId, t.at),
    index("run_usage_run_idx")
      .on(t.teamId, t.runId)
      .where(sql`${t.runId} IS NOT NULL`),
    index("run_usage_thread_idx")
      .on(t.teamId, t.threadId)
      .where(sql`${t.threadId} IS NOT NULL`),
    // Usage per agent (inventory, KOBE-86).
    index("run_usage_agent_idx")
      .on(t.teamId, t.agentId)
      .where(sql`${t.agentId} IS NOT NULL`),
    check("run_usage_route", sql`${t.route} IN (${list(USAGE_ROUTES)})`),
    check("run_usage_source", sql`${t.usageSource} IN (${list(USAGE_SOURCES)})`),
    check(
      "run_usage_model",
      sql`char_length(${t.model}) BETWEEN 1 AND ${sql.raw(String(USAGE_MODEL_MAX_CHARS))}`,
    ),
    check("run_usage_status", sql`${t.status} BETWEEN 100 AND 599`),
    check(
      "run_usage_tokens",
      sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.cacheReadTokens} >= 0 AND ${t.cacheWriteTokens} >= 0`,
    ),
    check("run_usage_cost", sql`${t.costUsd} IS NULL OR ${t.costUsd} >= 0`),
    check(
      "run_usage_timing",
      sql`${t.durationMs} >= 0 AND (${t.ttfbMs} IS NULL OR ${t.ttfbMs} >= 0)`,
    ),
    // KOBE-234's `run_usage_kind` (kind IN USAGE_KINDS) and `run_usage_kind_shape` (a run call
    // names its sandbox; a server call names none and always its triggering run) are added NOT
    // VALID by the custom migration 0100, not declared here: drizzle cannot express NOT VALID, and
    // a generated migration's hand edits would be lost when db:rebase regenerates it.
    check("run_usage_thread_needs_run", sql`${t.threadId} IS NULL OR ${t.runId} IS NOT NULL`),
  ],
);
