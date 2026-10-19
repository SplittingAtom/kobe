-- KOBE-438 (MCP Apps MA10; spec D5, D18): team isolation and legal-hold guards for
-- thread_app_results (0157). Custom, so db:rebase keeps this SQL as written. The table is new and
-- empty, so nothing is backfilled and FORCE RLS needs no lifting.
--
-- Team isolation: the canonical policy, as in 0005_conversations_rls.sql. No break_glass_read
-- policy: a break-glass reader (D10) always gets the text card (spec T12), never the structured
-- result, so the grant reads nothing here.
-- Legal hold (D18): results follow their thread, shaped like artifacts' guards (0067): a delete
-- that would remove a held thread's rows is refused, and TRUNCATE is refused while any hold is
-- active. A held thread is never purged, so its cascade never fires.
-- Run key: a result names the run that made it while it exists; deleting the run (its thread's
-- purge) clears only run_id. A fork's copies have no run (runs are not copied).

ALTER TABLE "thread_app_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "thread_app_results" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "thread_app_results"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE FUNCTION "public"."thread_app_results_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.thread_id FROM gone d) g
    LEFT JOIN "public"."threads" t ON t.team_id = g.team_id AND t.id = g.thread_id
    WHERE "public"."legal_hold_covers"(g.team_id, t.owner_user_id)) THEN
    RAISE EXCEPTION 'app results under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "thread_app_results_legal_hold" AFTER DELETE ON "thread_app_results"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."thread_app_results_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "thread_app_results_legal_hold_truncate" BEFORE TRUNCATE ON "thread_app_results"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
ALTER TABLE "thread_app_results" ADD CONSTRAINT "thread_app_results_run_fk"
  FOREIGN KEY ("team_id", "run_id") REFERENCES "public"."runs" ("team_id", "id")
  ON DELETE SET NULL ("run_id");
