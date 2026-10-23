-- KOBE-492: team isolation and the run key for workspace_sync_conflicts (0178). Custom, so
-- db:rebase keeps this SQL as written. The table is new and empty: nothing is backfilled and
-- FORCE RLS needs no lifting.
--
-- Team isolation: the canonical policy, as for workspace_moves (0117). No break_glass_read policy:
-- the rows are a member's operational notices (file names and hashes), not conversation content.
-- No legal-hold guard: rows tied to a thread follow it (a held thread is never purged, so its
-- cascade never fires); the conflict copy itself is a workspace file, kept by the workspace's own
-- hold rules.
-- Run key: a conflict names the run that last wrote the path while that run exists; deleting the
-- run clears only run_id (drizzle cannot express ON DELETE SET NULL (column)).

ALTER TABLE "workspace_sync_conflicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_sync_conflicts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "workspace_sync_conflicts"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "workspace_sync_conflicts" ADD CONSTRAINT "workspace_sync_conflicts_run_fk"
  FOREIGN KEY ("team_id", "run_id") REFERENCES "public"."runs" ("team_id", "id")
  ON DELETE SET NULL ("run_id");
