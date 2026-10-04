-- Team isolation for the model usage ledger (KOBE-43, spec D5, D30): ENABLE + FORCE RLS and the
-- canonical policy, as in 0001_team_rls.sql.
ALTER TABLE "run_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_usage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "run_usage"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
