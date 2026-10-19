-- KOBE-439 review LOW-C: the run-end discard of unclaimed MCP Apps results (0160) takes the
-- legal-hold lock before it checks for a hold, like every other hold-aware delete. Custom, so
-- db:rebase keeps this SQL as written. Same function, same trigger.

CREATE OR REPLACE FUNCTION "public"."thread_app_results_discard_unclaimed"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  owner uuid;
BEGIN
  -- The hold lock first (as the delete guard of 0158 takes it), so a hold that commits meanwhile
  -- cannot make the guard abort the run's end (KOBE-439 review LOW-C).
  PERFORM "public"."legal_hold_lock_shared"();
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
$$;
