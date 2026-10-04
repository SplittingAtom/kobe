-- Team isolation for team-level agent suspensions (KOBE-86): ENABLE + FORCE RLS and the canonical
-- policy, as in 0001_team_rls.sql.
ALTER TABLE "team_agent_suspensions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_agent_suspensions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_agent_suspensions"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
