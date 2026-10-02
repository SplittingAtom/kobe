-- Team isolation for team agents (spec D5): ENABLE + FORCE RLS and the canonical policy, as in
-- 0001_team_rls.sql. Personal and gallery agents (install_agents) are install-wide (D6) and have no
-- team RLS; the server confines personal rows to their owner.
ALTER TABLE "team_agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_agents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_agents"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
