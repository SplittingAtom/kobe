-- Team isolation for the Orbit eval gate (KOBE-93): ENABLE + FORCE RLS and the canonical policy, as in 0001_team_rls.sql.
ALTER TABLE "team_eval_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_eval_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_eval_settings"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "orbit_evals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orbit_evals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "orbit_evals"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
