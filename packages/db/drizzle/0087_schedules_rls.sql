-- Team isolation for schedules (KOBE-172, spec D32): the canonical policy as in
-- 0001_team_rls.sql. threads.schedule_id and the schedule.fire events index need no policy of
-- their own: the existing threads and events policies cover every column and row.
ALTER TABLE "schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schedules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "schedules"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
-- Deleting a schedule keeps the threads it created (they are the owner's conversations) and only
-- clears the link. The column list limits SET NULL to schedule_id: team_id is NOT NULL and part
-- of threads' key (PostgreSQL 15+). drizzle cannot express it, hence SQL-only.
ALTER TABLE "threads" ADD CONSTRAINT "threads_schedule_fk"
  FOREIGN KEY ("team_id", "schedule_id") REFERENCES "schedules" ("team_id", "id")
  ON DELETE SET NULL ("schedule_id");
