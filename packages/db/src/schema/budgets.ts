import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { teams } from "./teams.js";

// Budgets and rate limits (KOBE-42, spec D30): dollar budgets and token budgets (user decision
// 2026-10-04: token budgets cap models without catalog prices), monthly with an optional daily
// cap, at the install, team and user-in-team levels; per-user request rate limits at the gateway.
// Spend is the `run_usage` ledger (KOBE-43), summed per day by a trigger into `model_spend_daily`
// (team) and `install_model_spend_daily` (install), so a budget check reads at most 31 small rows.
// Tokens count every token a call processed: input + output + cache reads + cache writes.
// Periods are calendar months and days in UTC.

/** Largest budget an admin may set, in dollars (a typo guard, not a policy). */
export const MAX_BUDGET_USD = 1_000_000_000;
/** Largest token budget an admin may set (a typo guard). */
export const MAX_BUDGET_TOKENS = 1_000_000_000_000_000;
/** Per-user model requests per minute: bounds of the setting. */
export const MAX_REQUESTS_PER_MINUTE = 10_000;
export const DEFAULT_REQUESTS_PER_MINUTE = 60;
/** D30: warn at 80 %, stop at 100 %. */
export const BUDGET_THRESHOLDS = [80, 100] as const;
export type BudgetThreshold = (typeof BUDGET_THRESHOLDS)[number];
export const BUDGET_SCOPES = ["install", "team", "user"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];
export const BUDGET_PERIODS = ["month", "day"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];
/** What a budget counts: dollars at catalog prices, or tokens (any model, priced or not). */
export const BUDGET_UNITS = ["usd", "tokens"] as const;
export type BudgetUnit = (typeof BUDGET_UNITS)[number];

const list = (values: readonly (string | number)[]) =>
  sql.raw(values.map((v) => (typeof v === "number" ? String(v) : `'${v}'`)).join(", "));
const usd = () => numeric({ precision: 14, scale: 2, mode: "number" });
const amountOk = (c: unknown) =>
  sql`(${c} IS NULL OR ${c} BETWEEN 0 AND ${sql.raw(String(MAX_BUDGET_USD))})`;
const tokens = () => bigint({ mode: "number" });
const tokensOk = (c: unknown) =>
  sql`(${c} IS NULL OR ${c} BETWEEN 0 AND ${sql.raw(String(MAX_BUDGET_TOKENS))})`;
const rpmOk = (c: unknown) =>
  sql`(${c} IS NULL OR ${c} BETWEEN 1 AND ${sql.raw(String(MAX_REQUESTS_PER_MINUTE))})`;
const ts = () => timestamp({ withTimezone: true }).notNull().defaultNow();

/**
 * Install-wide (†), one row (seeded): the install budget (Bifrost customer level, D30) and the
 * per-user request rate every team gets unless it sets a lower one.
 */
export const installModelLimits = pgTable(
  "install_model_limits",
  {
    id: smallint().primaryKey().default(1),
    monthlyUsd: usd(),
    dailyUsd: usd(),
    monthlyTokens: tokens(),
    dailyTokens: tokens(),
    userRequestsPerMinute: integer().notNull().default(DEFAULT_REQUESTS_PER_MINUTE),
    updatedBy: uuid().references(() => users.id),
    updatedAt: ts(),
  },
  (t) => [
    check("install_model_limits_singleton", sql`${t.id} = 1`),
    check(
      "install_model_limits_amounts",
      sql`${amountOk(t.monthlyUsd)} AND ${amountOk(t.dailyUsd)} AND ${tokensOk(t.monthlyTokens)} AND ${tokensOk(t.dailyTokens)}`,
    ),
    check("install_model_limits_rpm", rpmOk(t.userRequestsPerMinute)),
  ],
);

/**
 * Team table: the team's budget (`user_id` null) and optional per-member budgets (user-in-team,
 * D30). Only the team row may lower the per-user request rate.
 */
export const teamBudgets = pgTable(
  "team_budgets",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    id: uuid().notNull().defaultRandom(),
    userId: uuid().references(() => users.id),
    monthlyUsd: usd(),
    dailyUsd: usd(),
    monthlyTokens: tokens(),
    dailyTokens: tokens(),
    userRequestsPerMinute: integer(),
    updatedBy: uuid()
      .notNull()
      .references(() => users.id),
    updatedAt: ts(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.id] }),
    uniqueIndex("team_budgets_team_idx")
      .on(t.teamId)
      .where(sql`${t.userId} IS NULL`),
    uniqueIndex("team_budgets_user_idx")
      .on(t.teamId, t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
    check(
      "team_budgets_amounts",
      sql`${amountOk(t.monthlyUsd)} AND ${amountOk(t.dailyUsd)} AND ${tokensOk(t.monthlyTokens)} AND ${tokensOk(t.dailyTokens)}`,
    ),
    check("team_budgets_rpm", rpmOk(t.userRequestsPerMinute)),
    check(
      "team_budgets_rpm_team_only",
      sql`${t.userRequestsPerMinute} IS NULL OR ${t.userId} IS NULL`,
    ),
  ],
);

/** Team table: spend per (day, user), maintained by the `run_usage` insert trigger. */
export const modelSpendDaily = pgTable(
  "model_spend_daily",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    day: date({ mode: "string" }).notNull(),
    userId: uuid().notNull(),
    costUsd: numeric({ precision: 24, scale: 10, mode: "number" }).notNull().default(0),
    /** Input + output + cache read + cache write tokens. */
    tokens: bigint({ mode: "number" }).notNull().default(0),
    calls: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.day, t.userId] })],
);

/** Install-wide (†): spend of every team per day (install budget); no team ids. */
export const installModelSpendDaily = pgTable("install_model_spend_daily", {
  day: date({ mode: "string" }).primaryKey(),
  costUsd: numeric({ precision: 24, scale: 10, mode: "number" }).notNull().default(0),
  tokens: bigint({ mode: "number" }).notNull().default(0),
});

/**
 * Install-wide (†): a budget threshold crossed in a period, recorded once (the unique key across
 * replicas) — the warning/stop log and the outbox source. Ids and amounts only, never content.
 */
export const budgetAlerts = pgTable(
  "budget_alerts",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Null for the install budget. */
    teamId: uuid(),
    /** Set for a user-in-team budget. */
    userId: uuid(),
    scope: text().$type<BudgetScope>().notNull(),
    period: text().$type<BudgetPeriod>().notNull(),
    periodStart: date({ mode: "string" }).notNull(),
    threshold: smallint().$type<BudgetThreshold>().notNull(),
    unit: text().$type<BudgetUnit>().notNull(),
    /** The budget and what was spent when the threshold was crossed, in `unit`. */
    limitAmount: numeric({ precision: 24, scale: 2, mode: "number" }).notNull(),
    spentAmount: numeric({ precision: 30, scale: 10, mode: "number" }).notNull(),
    createdAt: ts(),
  },
  (t) => [
    unique("budget_alerts_once")
      .on(t.teamId, t.userId, t.scope, t.unit, t.period, t.periodStart, t.threshold)
      .nullsNotDistinct(),
    index("budget_alerts_team_idx").on(t.teamId, t.createdAt),
    check("budget_alerts_scope", sql`${t.scope} IN (${list(BUDGET_SCOPES)})`),
    check("budget_alerts_period", sql`${t.period} IN (${list(BUDGET_PERIODS)})`),
    check("budget_alerts_threshold", sql`${t.threshold} IN (${list(BUDGET_THRESHOLDS)})`),
    // A threshold is only recorded once crossed (a forged early row could not pre-empt it).
    check("budget_alerts_unit", sql`${t.unit} IN (${list(BUDGET_UNITS)})`),
    check(
      "budget_alerts_crossed",
      sql`${t.spentAmount} >= ${t.limitAmount} * ${t.threshold} / 100`,
    ),
    check(
      "budget_alerts_subject",
      sql`(${t.scope} = 'install' AND ${t.teamId} IS NULL AND ${t.userId} IS NULL)
        OR (${t.scope} = 'team' AND ${t.teamId} IS NOT NULL AND ${t.userId} IS NULL)
        OR (${t.scope} = 'user' AND ${t.teamId} IS NOT NULL AND ${t.userId} IS NOT NULL)`,
    ),
  ],
);

export const BUDGET_EMAIL_STATUSES = ["pending", "sent", "skipped", "failed"] as const;
export type BudgetEmailStatus = (typeof BUDGET_EMAIL_STATUSES)[number];

/** Install-wide (†): one email per alert and recipient (durable outbox, at least once). */
export const budgetAlertEmails = pgTable(
  "budget_alert_emails",
  {
    id: uuid().primaryKey().defaultRandom(),
    alertId: uuid()
      .notNull()
      .references(() => budgetAlerts.id, { onDelete: "cascade" }),
    recipientId: uuid()
      .notNull()
      .references(() => users.id),
    status: text().$type<BudgetEmailStatus>().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: ts(),
    /** Machine-readable failure code of the last attempt. */
    lastError: text(),
    createdAt: ts(),
    sentAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique("budget_alert_emails_once").on(t.alertId, t.recipientId),
    index("budget_alert_emails_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    check("budget_alert_emails_status", sql`${t.status} IN (${list(BUDGET_EMAIL_STATUSES)})`),
    check(
      "budget_alert_emails_error",
      sql`${t.lastError} IS NULL OR ${t.lastError} ~ '^[a-z0-9_]{1,64}$'`,
    ),
  ],
);
