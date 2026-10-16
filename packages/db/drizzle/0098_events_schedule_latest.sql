-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-252: two scheduler lookups get an index.
--
-- 1. The skip dedupe reads the schedule's latest schedule.fire / schedule.skip event
--    (services/server src/scheduler/fire.ts, latestEvent; KOBE-180). events_schedule_fire_uniq
--    (0087) covers fires only, so that lookup scanned the team's events on every skipped
--    occurrence. It is keyed on a typed events.schedule_id, not on lower(ref->>'schedule_id'): the
--    app role reads events under FORCE ROW LEVEL SECURITY, where only LEAKPROOF quals may become
--    index conditions (as in 0013). uuid equality is leakproof; `->>` and lower() are not, so an
--    index on that expression is only ever matched on team_id (measured, docs/ledger/KOBE-252.md).
--    The writers set the column on fires and skips. Rows without it (written before this
--    migration, or by a previous release's pods during a rolling update) cost at most one extra or
--    one missing skip row per schedule; fire dedupe stays on events_schedule_fire_uniq. No
--    backfill: it would rewrite every fire and skip row inside the migration's transaction.
-- 2. The owner sweep (services/server src/scheduler/owner-sweep.ts) looks for a team's in-flight
--    scheduled runs on every tick, on every scheduler replica. runs had no index on trigger and
--    status, so that read the team's runs.
--
-- Locks: drizzle runs all pending migrations in ONE transaction. ADD COLUMN and ADD CONSTRAINT take
-- an ACCESS EXCLUSIVE lock on events and keep it until commit, so while the plain CREATE INDEX on
-- events scans, reads AND writes of events wait. The runs index holds a SHARE lock on runs (writes
-- wait) while it scans. On a large site, add the column and build both indexes beforehand with
-- these definitions and CREATE INDEX CONCURRENTLY (docs/install.md, "Upgrading"); the IF NOT
-- EXISTS below then skips them, and the remaining statements are catalog-only. Hand-written
-- because drizzle generates neither IF NOT EXISTS nor NOT VALID.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "schedule_id" uuid;--> statement-breakpoint
-- The typed key always matches the ref the rest of Kobe reads. NOT VALID: no scan; it checks the
-- rows written from now on (every existing row has schedule_id NULL, which passes).
ALTER TABLE "events" ADD CONSTRAINT "events_schedule_id_ref"
  CHECK ("schedule_id" IS NULL OR "schedule_id"::text = lower("ref"->>'schedule_id')) NOT VALID;--> statement-breakpoint
-- Partial on the two kinds; the lookup states the same literal IN list, so the planner proves the
-- predicate with bound parameters and in generic plans. created_at DESC serves ORDER BY created_at
-- DESC LIMIT 1; the due_at tie-break (a `collapsed` skip and its fire share created_at) sorts the
-- rows of one created_at incrementally. Not unique: a schedule has many fires and skips.
CREATE INDEX IF NOT EXISTS "events_schedule_latest_idx" ON "events"
  USING btree ("team_id", "schedule_id", "created_at" DESC)
  WHERE "kind" IN ('schedule.fire', 'schedule.skip');--> statement-breakpoint
-- A team's in-flight scheduled runs (few at any time), for the owner sweep and
-- cancelScheduledRuns. Both state the same literal predicate; team_id is the (leakproof) index
-- condition under RLS, thread_id feeds the join to threads.
CREATE INDEX IF NOT EXISTS "runs_schedule_live_idx" ON "runs"
  USING btree ("team_id", "thread_id")
  WHERE "trigger" = 'schedule' AND "status" IN ('queued', 'running', 'waiting_approval');
