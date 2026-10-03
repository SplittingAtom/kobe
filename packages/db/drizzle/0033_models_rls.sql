-- Team isolation for team model enablement and the members' gateway virtual keys (KOBE-40, spec
-- D5, D30): ENABLE + FORCE RLS and the canonical policy, as in 0001_team_rls.sql. Providers, the
-- catalog and the sync state are install-wide.
ALTER TABLE "team_models" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_models" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_models"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "model_gateway_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_gateway_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "model_gateway_keys"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
-- The gateway sync's single progress row.
INSERT INTO "model_gateway_state" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
