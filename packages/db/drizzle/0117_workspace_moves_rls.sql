-- KOBE-304 review: workspace_moves, the move journal the sandbox agent replays as local renames.
-- Custom, so db:rebase keeps this SQL as written. The table is new (0116): nothing here scans or
-- rewrites existing data. The canonical team policy only, as for workspace_files (no break-glass
-- read). No legal-hold guard: the journal is operational and is trimmed after the tombstone TTL;
-- a held member's moved paths are kept in workspace_file_hold_history (0115).

ALTER TABLE "workspace_moves" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_moves" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "workspace_moves"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
