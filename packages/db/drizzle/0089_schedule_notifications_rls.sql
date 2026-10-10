-- Team isolation for notifications, notification_emails and run_skipped_actions (KOBE-177, spec D32):
-- the canonical policy as in 0001_team_rls.sql. Their cascades from threads/runs are covered by the
-- legal-hold triggers on those parents (0033).
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "notifications"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "notification_emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_emails" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "notification_emails"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "run_skipped_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_skipped_actions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "run_skipped_actions"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
--> statement-breakpoint
-- Deleting a schedule keeps its notifications and only clears the link, so a held thread's run
-- notifications survive it (a cascade would bypass the legal-hold guards). The column list limits
-- SET NULL to schedule_id: team_id is NOT NULL (PostgreSQL 15+); drizzle cannot express it.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_schedule_fk"
  FOREIGN KEY ("team_id", "schedule_id") REFERENCES "schedules" ("team_id", "id")
  ON DELETE SET NULL ("schedule_id");
