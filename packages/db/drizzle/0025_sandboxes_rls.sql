-- Team isolation for the sandbox lifecycle table (KOBE-25, spec D5, D14): ENABLE + FORCE RLS and
-- the canonical policy, as in 0001_team_rls.sql.
ALTER TABLE "sandboxes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandboxes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "sandboxes"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
