-- Team isolation for run-bound gateway tokens (KOBE-118): ENABLE + FORCE RLS and the canonical
-- policy, as in 0001_team_rls.sql.
ALTER TABLE "run_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "run_tokens"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
