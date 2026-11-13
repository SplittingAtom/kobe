-- KOBE-645 (v1.3 Semantic Memory SMA13): team isolation for the pending-object registry of 0220.
-- Custom, so db:rebase keeps this SQL as written. ENABLE + FORCE RLS and the canonical policy, as
-- in 0219_memory_stewards_rls.sql. The table is new and empty. 0220 also widened the
-- `notifications` kind, shape and actor checks with every memory kind; existing rows satisfy the
-- new checks unchanged (every new column is null on them).
ALTER TABLE "memory_reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_reminders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "memory_reminders"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
