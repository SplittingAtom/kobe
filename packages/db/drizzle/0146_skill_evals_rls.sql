-- KOBE-325 (Skills v1.2, SK16; D5, D10, D13, D18): row security, keys and legal-hold handling for
-- the skill eval tables of 0145_skill_evals, the eval sandboxes' wire connections, the wire's slot
-- rules and the SQL-only objects of the threads columns. Custom, so db:rebase keeps this SQL as
-- written. The new tables are empty, so nothing is backfilled and FORCE RLS needs no lifting.
--
-- Team isolation, as in 0001_team_rls.sql: ENABLE + FORCE RLS and the canonical policy. Who in the
-- team reads an eval (its starter, and who can see its subject) is the server's decision.
-- Break-glass (D10): a SELECT-only break_glass_read policy shaped like skill_drafts' (0142): a team
-- grant reads the team's evals, a user grant those the user started, a thread grant none (an eval
-- thread is a thread: the thread grant reads it through the thread tables' own policies). The eval
-- sandboxes' connections are wire bookkeeping like sandbox_connections (0017): no break-glass.
--
-- Rolling upgrade and helm rollback (docs/install.md): nothing here changes a key or index the
-- previous release uses. sandbox_connections keeps its (team_id, user_id) primary key (that
-- release upserts ON CONFLICT on it); eval sandboxes connect through sandbox_eval_connections. The
-- slot columns of sandbox_commands / sandbox_run_leases default to '' (the member's sandbox), which
-- every rule below accepts for an ordinary thread, so the old release's inserts keep working.
--
-- Legal hold (D18): a hold never refuses or shows itself. Nobody deletes eval runs by hand; when a
-- purge (retention, offboarding) deletes a run whose starter a hold covers, the row trigger below
-- skips that row silently, so the run and its results (the cascade never fires) stay until no hold
-- covers the starter. A result's own delete is skipped the same way. TRUNCATE is refused while any
-- hold is active. So a purge deletes a run's stored objects (bundle_key, fixtures_key) only for the
-- rows its DELETE ... RETURNING returned: a skipped (held) run keeps its objects. Every function is
-- SECURITY INVOKER (the default): RLS applies inside them too.

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
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint

-- Eval sandboxes' wire connections: team isolation as for sandbox_connections.
ALTER TABLE "sandbox_eval_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandbox_eval_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "sandbox_eval_connections"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- An eval connection belongs to an eval thread, as that thread's owner. A missing thread is left
-- to the foreign key.
CREATE FUNCTION "public"."sandbox_eval_connections_thread"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  t record;
BEGIN
  SELECT th.skill_eval, th.owner_user_id INTO t FROM "public"."threads" th
   WHERE th.team_id = NEW.team_id AND th.id = NEW.thread_id;
  IF FOUND AND NOT (t.skill_eval AND t.owner_user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'an eval sandbox connection needs an eval thread of its user'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "sandbox_eval_connections_thread" BEFORE INSERT OR UPDATE OF "thread_id", "user_id"
  ON "sandbox_eval_connections" FOR EACH ROW EXECUTE FUNCTION "public"."sandbox_eval_connections_thread"();--> statement-breakpoint

-- Wire slots. A command or lease is for the member's sandbox ('') or for its own thread's eval
-- sandbox ('e-' || thread_id), never another thread's: so a normal thread's run can't be sent to
-- an eval sandbox under a stray slot. Locks: sandbox_commands and sandbox_run_leases are held
-- ACCESS EXCLUSIVE by 0145's ADD COLUMN until commit, and every existing row has slot '' (passes),
-- so the checks are NOT VALID with no VALIDATE: nothing scans the (growing) lease table.
ALTER TABLE "sandbox_commands" ADD CONSTRAINT "sandbox_commands_slot"
  CHECK ("slot" = '' OR "slot" = 'e-' || "thread_id"::text) NOT VALID;--> statement-breakpoint
ALTER TABLE "sandbox_run_leases" ADD CONSTRAINT "sandbox_run_leases_slot"
  CHECK ("slot" = '' OR "slot" = 'e-' || "thread_id"::text) NOT VALID;--> statement-breakpoint
-- And the other way: an eval thread's command or lease is always for its eval sandbox, an ordinary
-- thread's always for the member's, so an eval run (someone's skill, as its starter) never reaches
-- the member's own sandbox. One primary-key lookup per insert. A missing thread is left to the
-- foreign key.
CREATE FUNCTION "public"."sandbox_wire_slot_matches_thread"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  is_eval boolean;
BEGIN
  SELECT th.skill_eval INTO is_eval FROM "public"."threads" th
   WHERE th.team_id = NEW.team_id AND th.id = NEW.thread_id;
  IF FOUND AND is_eval IS DISTINCT FROM (NEW.slot <> '') THEN
    RAISE EXCEPTION 'a % row for thread % goes to that thread''s own sandbox slot', TG_TABLE_NAME, NEW.thread_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "sandbox_commands_slot_thread" BEFORE INSERT OR UPDATE OF "slot", "thread_id"
  ON "sandbox_commands" FOR EACH ROW EXECUTE FUNCTION "public"."sandbox_wire_slot_matches_thread"();--> statement-breakpoint
CREATE TRIGGER "sandbox_run_leases_slot_thread" BEFORE INSERT OR UPDATE OF "slot", "thread_id"
  ON "sandbox_run_leases" FOR EACH ROW EXECUTE FUNCTION "public"."sandbox_wire_slot_matches_thread"();--> statement-breakpoint

-- A thread never becomes, or stops being, an eval thread: the slot rules above rely on it. Fires
-- only on an UPDATE that sets skill_eval.
CREATE FUNCTION "public"."threads_skill_eval_fixed"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.skill_eval IS DISTINCT FROM OLD.skill_eval THEN
    RAISE EXCEPTION 'threads.skill_eval never changes' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "threads_skill_eval_fixed" BEFORE UPDATE OF "skill_eval" ON "threads"
  FOR EACH ROW EXECUTE FUNCTION "public"."threads_skill_eval_fixed"();--> statement-breakpoint

-- A result's thread is an eval thread of the same eval run (never a member's chat). A missing
-- thread is left to the foreign key; clearing thread_id (ON DELETE SET NULL) passes.
CREATE FUNCTION "public"."skill_eval_results_thread"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  t record;
BEGIN
  IF NEW.thread_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT th.skill_eval, th.skill_eval_run_id INTO t FROM "public"."threads" th
   WHERE th.team_id = NEW.team_id AND th.id = NEW.thread_id;
  IF FOUND AND NOT (t.skill_eval AND t.skill_eval_run_id IS NOT DISTINCT FROM NEW.eval_run_id) THEN
    RAISE EXCEPTION 'an eval result''s thread is an eval thread of its own eval run'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_eval_results_thread" BEFORE INSERT OR UPDATE OF "thread_id", "eval_run_id"
  ON "skill_eval_results" FOR EACH ROW EXECUTE FUNCTION "public"."skill_eval_results_thread"();
