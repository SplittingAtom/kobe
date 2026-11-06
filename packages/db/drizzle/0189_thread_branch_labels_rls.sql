-- KOBE-543 (spec CT9): team isolation for thread_branch_labels (0188). Custom, so db:rebase keeps
-- this SQL as written. The canonical policy, as in 0005_conversations_rls.sql; the table is new and
-- empty, so FORCE RLS needs no lifting. No break_glass_read policy: a label is the owner's personal
-- organisation, not conversation content (a break-glass reader gets the thread without labels).
ALTER TABLE "thread_branch_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "thread_branch_labels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "thread_branch_labels"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
