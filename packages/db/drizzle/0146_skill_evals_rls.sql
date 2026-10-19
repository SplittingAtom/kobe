-- KOBE-325 (Skills v1.2, SK16; D5, D10, D18): row security, keys and legal-hold handling for the
-- skill eval tables of 0145_skill_evals, and the SQL-only objects of its threads columns. Custom,
-- so db:rebase keeps this SQL as written. The eval tables are new and empty, so nothing is
-- backfilled and FORCE RLS needs no lifting.
--
-- Team isolation, as in 0001_team_rls.sql: ENABLE + FORCE RLS and the canonical policy. Who in the
-- team reads an eval (its starter, and who can see its subject) is the server's decision.
-- Break-glass (D10): a SELECT-only break_glass_read policy shaped like skill_drafts' (0142): a team
-- grant reads the team's evals, a user grant those the user started, a thread grant none (an eval
-- thread is a thread: the thread grant reads it through the thread tables' own policies).
--
-- Legal hold (D18): a hold never refuses or shows itself. Nobody deletes eval runs by hand; when a
-- purge (retention, offboarding) deletes a run whose starter a hold covers, the row trigger below
-- skips that row silently, so the run and its results (the cascade never fires) stay until no hold
-- covers the starter. A result's own delete is skipped the same way. TRUNCATE is refused while any
-- hold is active. Every function is SECURITY INVOKER (the default): RLS applies inside them too.

ALTER TABLE "skill_eval_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_eval_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "skill_eval_runs"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "skill_eval_runs" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND (SELECT g.thread_id FROM "public"."break_glass_active_grant"() g) IS NULL
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL
      OR "started_by" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g))
  );--> statement-breakpoint

ALTER TABLE "skill_eval_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_eval_results" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "skill_eval_results"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "skill_eval_results" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND (SELECT g.thread_id FROM "public"."break_glass_active_grant"() g) IS NULL
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL
      OR EXISTS (
        SELECT 1 FROM "public"."skill_eval_runs" r
         WHERE r."team_id" = "skill_eval_results"."team_id" AND r."id" = "skill_eval_results"."eval_run_id"
           AND r."started_by" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g)))
  );--> statement-breakpoint

-- A result's eval thread is one of its own team: (team_id, thread_id) → threads; deleting the
-- thread (retention) clears only thread_id.
ALTER TABLE "skill_eval_results" ADD CONSTRAINT "skill_eval_results_thread_fk"
  FOREIGN KEY ("team_id", "thread_id") REFERENCES "public"."threads" ("team_id", "id")
  ON DELETE SET NULL ("thread_id");--> statement-breakpoint

-- Threads (0145 added skill_eval and skill_eval_run_id). Locks: the ADD COLUMNs hold ACCESS
-- EXCLUSIVE on threads until the migration commits, so nothing here scans it: every existing row
-- has skill_eval = false and skill_eval_run_id = NULL, which passes each constraint, so they are
-- NOT VALID with no VALIDATE (they hold for every row written from now on). The index is IF NOT
-- EXISTS: on a large site, build it beforehand with CREATE INDEX CONCURRENTLY and this definition.
ALTER TABLE "threads" ADD CONSTRAINT "threads_skill_eval_run_fk"
  FOREIGN KEY ("team_id", "skill_eval_run_id") REFERENCES "public"."skill_eval_runs" ("team_id", "id")
  ON DELETE SET NULL ("skill_eval_run_id") NOT VALID;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_skill_eval_run"
  CHECK ("skill_eval_run_id" IS NULL OR "skill_eval") NOT VALID;--> statement-breakpoint
-- An eval thread is never a Workbench test chat or a builder test thread, and sits in no project.
ALTER TABLE "threads" ADD CONSTRAINT "threads_skill_eval_only"
  CHECK (NOT ("skill_eval" AND ("skill_test" OR "is_test" OR "project_id" IS NOT NULL))) NOT VALID;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "threads_skill_eval_run_idx" ON "threads" ("team_id", "skill_eval_run_id")
  WHERE "skill_eval_run_id" IS NOT NULL;--> statement-breakpoint

-- The silent hold: a purge's delete of a held starter's run (or of one of its results) does nothing.
CREATE FUNCTION "public"."skill_eval_runs_keep_held"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF "public"."legal_hold_covers"(OLD.team_id, OLD.started_by) THEN
    RETURN NULL;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_eval_runs_keep_held" BEFORE DELETE ON "skill_eval_runs"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_eval_runs_keep_held"();--> statement-breakpoint

CREATE FUNCTION "public"."skill_eval_results_keep_held"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  starter uuid;
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  SELECT r.started_by INTO starter FROM "public"."skill_eval_runs" r
   WHERE r.team_id = OLD.team_id AND r.id = OLD.eval_run_id;
  -- The run row is gone only inside its own (unheld) cascade: then the result goes too.
  IF starter IS NOT NULL AND "public"."legal_hold_covers"(OLD.team_id, starter) THEN
    RETURN NULL;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_eval_results_keep_held" BEFORE DELETE ON "skill_eval_results"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_eval_results_keep_held"();--> statement-breakpoint

-- TRUNCATE skips row triggers: refused on both tables while any hold is active.
CREATE TRIGGER "skill_eval_runs_legal_hold_truncate" BEFORE TRUNCATE ON "skill_eval_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "skill_eval_results_legal_hold_truncate" BEFORE TRUNCATE ON "skill_eval_results"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();
