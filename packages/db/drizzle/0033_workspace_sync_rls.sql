-- Team isolation for the workspace sync tables (KOBE-27, spec D5, D26): ENABLE + FORCE RLS and the
-- canonical policy, as in 0001_team_rls.sql.
ALTER TABLE "workspace_sync" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_sync" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "workspace_sync"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "workspace_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "workspace_files"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "workspace_blobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_blobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "workspace_blobs"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
