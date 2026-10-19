-- KOBE-438 review MEDIUM-1 (MCP Apps MA10): a captured result that no tool.result claimed is
-- never shown, so it must not outlive its run. When a run leaves the active states (completed,
-- failed, cancelled, interrupted, budget_stopped; every path that ends a run updates
-- runs.status), its unclaimed rows are deleted in the same transaction and their blobs queued for
-- deletion (retention_blob_deletions, due now; the retention pass deletes them from the store).
-- They stop counting toward the team's storage quota at once. A held thread (D18) keeps them:
-- the legal-hold guard would refuse the delete, and a hold never shows itself.
-- Custom, so db:rebase keeps this SQL as written. SECURITY INVOKER (the default): RLS applies;
-- the run update runs inside its team's transaction.

CREATE FUNCTION "public"."thread_app_results_discard_unclaimed"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  owner uuid;
BEGIN
  SELECT t.owner_user_id INTO owner FROM "public"."threads" t
   WHERE t.team_id = NEW.team_id AND t.id = NEW.thread_id;
  IF owner IS NULL OR "public"."legal_hold_covers"(NEW.team_id, owner) THEN
    RETURN NULL;
  END IF;
  INSERT INTO "public"."retention_blob_deletions" (team_id, key, thread_id, owner_user_id, enqueued_at)
    SELECT a.team_id, a.blob_ref, a.thread_id, owner, now()
      FROM "public"."thread_app_results" a
     WHERE a.team_id = NEW.team_id AND a.run_id = NEW.id
       AND a.tool_call_id IS NULL AND a.entry_id IS NULL AND a.blob_ref IS NOT NULL
  ON CONFLICT (team_id, key) DO UPDATE SET enqueued_at = now();
  DELETE FROM "public"."thread_app_results"
   WHERE team_id = NEW.team_id AND run_id = NEW.id AND tool_call_id IS NULL AND entry_id IS NULL;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "runs_discard_unclaimed_app_results" AFTER UPDATE OF "status" ON "runs"
  FOR EACH ROW
  WHEN (OLD.status IN ('queued', 'running', 'waiting_approval')
    AND NEW.status NOT IN ('queued', 'running', 'waiting_approval'))
  EXECUTE FUNCTION "public"."thread_app_results_discard_unclaimed"();
