-- KOBE-565 (agents-roster AR3): team isolation for team_agent_roster (0193). Custom, so db:rebase
-- keeps this SQL as written. The canonical policy, as in 0053_agent_suspensions_rls.sql; the table
-- is new and empty. site_agent_roster is site-wide (no team data) and has no RLS.
ALTER TABLE "team_agent_roster" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_agent_roster" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_agent_roster"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
