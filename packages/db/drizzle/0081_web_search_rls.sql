-- Team isolation for team_web_search (KOBE-113, spec D5): the canonical policy as in
-- 0001_team_rls.sql. web_search_settings is install-wide (one row, sealed key, no team data) and
-- carries no team RLS; the app role's privileges on it come from tenancy/connectors.ts.
ALTER TABLE "team_web_search" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_web_search" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_web_search"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
