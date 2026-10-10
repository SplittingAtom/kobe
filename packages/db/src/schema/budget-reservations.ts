import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

// Shared budget reservations (KOBE-120, part of KOBE-95): what an admitted model call may still
// cost, held from admission until its ledger row lands, so every model-gateway replica sees the
// others' in-flight calls (before, each replica held its own in memory). Postgres is the durable
// record; there is no Redis.
//
// Every reservation has an expiry (`expires_at`). Expired rows never count (readers filter on
// `expires_at > now()` even before a sweep deletes them), so a replica that crashes mid-call
// frees its reservations by itself, and a lost ledger write cannot hold budget forever.
// `kobe_reserve_budget()` (migration 0084) is the single atomic entry point for reserving.

/** A reservation's amounts: dollars at catalog prices and tokens (as `run_usage` counts them). */
const amounts = () => ({
  usd: numeric({ precision: 20, scale: 12, mode: "number" }).notNull().default(0),
  tokens: bigint({ mode: "number" }).notNull().default(0),
});

/** Team table: one row per admitted call that has a team or user budget line. */
export const budgetReservations = pgTable(
  "budget_reservations",
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    callId: text().notNull(),
    /** The member whose sandbox made the call (no FK: a reservation is short-lived). */
    userId: uuid().notNull(),
    ...amounts(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.callId] }),
    check("budget_reservations_call_id_len", sql`char_length(${t.callId}) BETWEEN 1 AND 128`),
    check("budget_reservations_amounts", sql`${t.usd} >= 0 AND ${t.tokens} >= 0`),
    index("budget_reservations_expiry_idx").on(t.teamId, t.expiresAt),
  ],
);

/**
 * Install-wide (†): the same reservation counted against the install budget, which spans teams
 * and so cannot live in a team table (RLS would hide other teams' rows). It holds no team or
 * user ids: `team_key` and `member_key` are salted SHA-256 hashes (the salt is a per-install
 * secret the gateways share), enough for equality (a team ends only its own holds; the
 * per-member share) and useless for reading who reserved. Computed inside the functions.
 */
export const installBudgetReservations = pgTable(
  "install_budget_reservations",
  {
    teamKey: text().notNull(),
    callId: text().notNull(),
    memberKey: text().notNull(),
    ...amounts(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamKey, t.callId] }),
    check(
      "install_budget_reservations_call_id_len",
      sql`char_length(${t.callId}) BETWEEN 1 AND 128`,
    ),
    check("install_budget_reservations_amounts", sql`${t.usd} >= 0 AND ${t.tokens} >= 0`),
    index("install_budget_reservations_expiry_idx").on(t.expiresAt),
  ],
);
