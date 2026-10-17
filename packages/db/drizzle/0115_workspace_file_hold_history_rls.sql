-- KOBE-304: workspace_file_hold_history, a legal hold's copy of where moved workspace files were
-- (the KOBE-275 history pattern). Custom, so db:rebase keeps this SQL as written. The table is new
-- (0114): nothing here scans or rewrites existing data.
--
-- The file browser's move inserts the rows itself, in the move's transaction and only while
-- `legal_hold_covers(team_id, user_id)` (after taking the legal-hold lock shared), and answers as
-- usual: a hold is never refused or otherwise visible to the member. Here: the canonical team
-- policy (no break_glass_read: workspace_files has none either), immutability, and deletion and
-- TRUNCATE refused while a hold covers the member. The retention pass purges rows once none does.

ALTER TABLE "workspace_file_hold_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_file_hold_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "workspace_file_hold_history"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

CREATE FUNCTION "public"."workspace_file_hold_history_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.user_id FROM gone d) g
    WHERE "public"."legal_hold_covers"(g.team_id, g.user_id)) THEN
    RAISE EXCEPTION 'workspace hold history under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "workspace_file_hold_history_legal_hold" AFTER DELETE ON "workspace_file_hold_history"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."workspace_file_hold_history_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "workspace_file_hold_history_legal_hold_truncate" BEFORE TRUNCATE ON "workspace_file_hold_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint

CREATE FUNCTION "public"."workspace_file_hold_history_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'workspace hold history is immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
-- Every column but team_id, which is left to RLS and the foreign keys (as for artifact_versions).
CREATE TRIGGER "workspace_file_hold_history_immutable" BEFORE UPDATE OF "id", "user_id", "path",
    "moved_to", "sha256", "blob_key", "size", "mtime_ms", "file_rev", "kept_at"
  ON "workspace_file_hold_history"
  FOR EACH ROW EXECUTE FUNCTION "public"."workspace_file_hold_history_immutable"();
