-- KOBE-451 (the composer's + menu): row security for 0165_thread_connectors_off. Custom, so
-- db:rebase keeps this SQL as written. The table is new and empty: nothing is backfilled and
-- FORCE RLS needs no lifting. The canonical team policy, as in 0005_conversations_rls.sql. No
-- break_glass_read policy: a break-glass reader has no use for an owner's connector setting.

ALTER TABLE "thread_connectors_off" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "thread_connectors_off" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "thread_connectors_off"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
