-- Team isolation for team connector enablement (KOBE-58, spec D5, D27): ENABLE + FORCE RLS and the
-- canonical policy, as in 0001_team_rls.sql. connectors is install-wide (the registry).
ALTER TABLE "team_connectors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_connectors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_connectors"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
