-- Team isolation for the conversation tables (spec D5): ENABLE + FORCE RLS and the canonical policy,
-- as in 0001_team_rls.sql.
ALTER TABLE "threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "threads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "threads"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "thread_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "thread_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "thread_entries"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "runs"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "run_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "run_events"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "events"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Gapless per-run seq (D16). Incrementing runs.last_seq takes the run's row lock until commit, so
-- appends to one run serialize and commit in seq order: once seq n is visible, every seq < n is too,
-- and a reader resuming with starting_after = n never skips an event. A rolled-back append rolls
-- back its increment, leaving no gap. SECURITY INVOKER (the default): the UPDATE runs under the
-- caller's RLS, so an event can only be appended to a run of the active team.
--
-- Contention: appenders hold the run row until commit, and status writers (stop, interrupt,
-- approval, budget stop) update the same row, so keep both kinds of transaction short and give
-- status paths a lock_timeout. Appends must run in READ COMMITTED (the default). Lock order: a
-- transaction that writes both a thread (entries, leaf, status) and one of its runs (events,
-- status) must touch the thread row first, or two writers can deadlock.
CREATE FUNCTION "public"."run_events_assign_seq"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.seq <> 0 THEN
    RAISE EXCEPTION 'run_events.seq is assigned by the database; omit it' USING ERRCODE = '428C9';
  END IF;
  UPDATE "public"."runs" SET "last_seq" = "last_seq" + 1
    WHERE "team_id" = NEW.team_id AND "id" = NEW.run_id
    RETURNING "last_seq" INTO NEW.seq;
  IF NEW.seq IS NULL THEN
    RAISE EXCEPTION 'run % not found in the active team', NEW.run_id USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "run_events_assign_seq" BEFORE INSERT ON "run_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."run_events_assign_seq"();--> statement-breakpoint

-- Per-thread entry order (D15), allocated the same way from threads.last_entry_seq.
CREATE FUNCTION "public"."thread_entries_assign_seq"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.seq <> 0 THEN
    RAISE EXCEPTION 'thread_entries.seq is assigned by the database; omit it' USING ERRCODE = '428C9';
  END IF;
  UPDATE "public"."threads" SET "last_entry_seq" = "last_entry_seq" + 1
    WHERE "team_id" = NEW.team_id AND "id" = NEW.thread_id
    RETURNING "last_entry_seq" INTO NEW.seq;
  IF NEW.seq IS NULL THEN
    RAISE EXCEPTION 'thread % not found in the active team', NEW.thread_id USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "thread_entries_assign_seq" BEFORE INSERT ON "thread_entries"
  FOR EACH ROW EXECUTE FUNCTION "public"."thread_entries_assign_seq"();--> statement-breakpoint

-- An event or entry never changes run/thread or seq once written: a same-team move or renumber
-- would plant a seq the counter never issued and break resume or JSONL order. Payloads stay
-- updatable. team_id is not checked here: any change to it is a cross-team move, which the RLS
-- WITH CHECK rejects (FORCE RLS binds every non-superuser role), and a trigger error here would
-- pre-empt that RLS error.
CREATE FUNCTION "public"."run_events_immutable_keys"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.seq IS DISTINCT FROM OLD.seq THEN
    RAISE EXCEPTION 'run_events.run_id and seq cannot be changed' USING ERRCODE = '428C9';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "run_events_immutable_keys" BEFORE UPDATE ON "run_events"
  FOR EACH ROW EXECUTE FUNCTION "public"."run_events_immutable_keys"();--> statement-breakpoint
CREATE FUNCTION "public"."thread_entries_immutable_keys"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.thread_id IS DISTINCT FROM OLD.thread_id OR NEW.seq IS DISTINCT FROM OLD.seq THEN
    RAISE EXCEPTION 'thread_entries.thread_id and seq cannot be changed' USING ERRCODE = '428C9';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "thread_entries_immutable_keys" BEFORE UPDATE ON "thread_entries"
  FOR EACH ROW EXECUTE FUNCTION "public"."thread_entries_immutable_keys"();--> statement-breakpoint

-- The counters change only through the seq triggers above (nested, so pg_trigger_depth() > 1),
-- and only by exactly 1. A direct app write could open a gap or reissue a seq.
CREATE FUNCTION "public"."runs_guard_last_seq"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.last_seq IS DISTINCT FROM OLD.last_seq
     AND NOT (pg_trigger_depth() > 1 AND NEW.last_seq = OLD.last_seq + 1) THEN
    RAISE EXCEPTION 'runs.last_seq is maintained by the database' USING ERRCODE = '428C9';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "runs_guard_last_seq" BEFORE UPDATE OF "last_seq" ON "runs"
  FOR EACH ROW EXECUTE FUNCTION "public"."runs_guard_last_seq"();--> statement-breakpoint
CREATE FUNCTION "public"."threads_guard_last_entry_seq"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.last_entry_seq IS DISTINCT FROM OLD.last_entry_seq
     AND NOT (pg_trigger_depth() > 1 AND NEW.last_entry_seq = OLD.last_entry_seq + 1) THEN
    RAISE EXCEPTION 'threads.last_entry_seq is maintained by the database' USING ERRCODE = '428C9';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "threads_guard_last_entry_seq" BEFORE UPDATE OF "last_entry_seq" ON "threads"
  FOR EACH ROW EXECUTE FUNCTION "public"."threads_guard_last_entry_seq"();--> statement-breakpoint

-- Every append updates its run (or thread) row once per inserted row. Free space per page keeps
-- those updates HOT (last_seq/last_entry_seq are not indexed) so page pruning reclaims the dead
-- versions without index churn or vacuum. Servers should still coalesce text deltas into fewer
-- events (KOBE-31).
ALTER TABLE "runs" SET (fillfactor = 70);--> statement-breakpoint
ALTER TABLE "threads" SET (fillfactor = 70);
