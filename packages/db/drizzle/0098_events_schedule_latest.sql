-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-252: the scheduler records a skip once per streak by reading the schedule's latest
-- schedule.fire / schedule.skip event (services/server src/scheduler/fire.ts, latestEvent;
-- KOBE-180). events_schedule_fire_uniq (0087) covers fires only, so that lookup scanned the
-- team's events on every skipped occurrence.
--
-- Keyed on a typed events.schedule_id, not on lower(ref->>'schedule_id'): the app role reads
-- events under FORCE ROW LEVEL SECURITY, where only LEAKPROOF quals may become index conditions
-- (as in 0013). uuid equality is leakproof; `->>` and lower() are not, so an index on that
-- expression is only ever matched on team_id (measured, docs/ledger/KOBE-252.md). The writers set
-- the column on fires and skips; events written before this migration have none, so a schedule in
-- a skip streak records its next skip once more, nothing else. No backfill: it would rewrite every
-- fire and skip row inside the migration's transaction.
--
-- Hand-written for IF NOT EXISTS on both statements (drizzle generates neither): drizzle runs
-- migrations in one transaction, so the index can't be built CONCURRENTLY here, and a plain build
-- holds a SHARE lock on events (writes wait) while it scans. On a large site, add the column and
-- build the index beforehand with these definitions and CREATE INDEX CONCURRENTLY; this migration
-- then skips both (docs/install.md, "Upgrading"). ADD COLUMN without a default changes the catalog
-- only (no table rewrite).
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "schedule_id" uuid;--> statement-breakpoint
-- Partial on the two kinds; the lookup states the same literal IN list, so the planner proves the
-- predicate with bound parameters and in generic plans. created_at DESC serves ORDER BY created_at
-- DESC LIMIT 1; the due_at tie-break (a `collapsed` skip and its fire share created_at) sorts the
-- rows of one created_at incrementally. Not unique: a schedule has many fires and skips.
CREATE INDEX IF NOT EXISTS "events_schedule_latest_idx" ON "events"
  USING btree ("team_id", "schedule_id", "created_at" DESC)
  WHERE "kind" IN ('schedule.fire', 'schedule.skip');
