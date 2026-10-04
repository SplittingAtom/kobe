-- Retention and deletion (spec D18, KOBE-18).
--
-- Team isolation for the retention tables (spec D5): ENABLE + FORCE RLS and the canonical policy,
-- as in 0001_team_rls.sql.
ALTER TABLE "team_retention" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_retention" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_retention"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "retention_blob_deletions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retention_blob_deletions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "retention_blob_deletions"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Legal hold backstop for the further tables a purge deletes from (KOBE-17 contract: "add the same
-- delete guards to any new table you purge"). Runs carry the user's message (`runs.input`) and run
-- events the live stream (compacted after 7 days, D18): deleting either for a held thread fails
-- with SQLSTATE KH001, like threads and thread_entries. One check per statement over the distinct
-- threads (transition tables), so bulk deletes and cascades stay cheap. A thread already gone in
-- the same statement (cascade) counts for team-wide holds only; its own BEFORE DELETE guard has
-- checked the owner. SECURITY INVOKER (the default), as every Kobe function.
CREATE FUNCTION "public"."runs_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.thread_id FROM gone d) g
    LEFT JOIN "public"."threads" t ON t.team_id = g.team_id AND t.id = g.thread_id
    WHERE "public"."legal_hold_covers"(g.team_id, t.owner_user_id)) THEN
    RAISE EXCEPTION 'runs under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "runs_legal_hold" AFTER DELETE ON "runs"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."runs_legal_hold_guard"();--> statement-breakpoint

CREATE FUNCTION "public"."run_events_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.run_id FROM gone d) g
    LEFT JOIN "public"."runs" r ON r.team_id = g.team_id AND r.id = g.run_id
    LEFT JOIN "public"."threads" t ON t.team_id = r.team_id AND t.id = r.thread_id
    WHERE "public"."legal_hold_covers"(g.team_id, t.owner_user_id)) THEN
    RAISE EXCEPTION 'run events under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "run_events_legal_hold" AFTER DELETE ON "run_events"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."run_events_legal_hold_guard"();--> statement-breakpoint

-- TRUNCATE skips row and statement delete triggers: refused while any hold is active (as for
-- threads and thread_entries; the app role has no TRUNCATE).
CREATE TRIGGER "runs_legal_hold_truncate" BEFORE TRUNCATE ON "runs"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "run_events_legal_hold_truncate" BEFORE TRUNCATE ON "run_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();
