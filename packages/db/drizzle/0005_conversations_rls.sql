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
-- Appenders must use READ COMMITTED (the default); keep append transactions short. Lock order: a
-- transaction that writes both a thread (entries, leaf, status) and one of its runs (events,
-- status) must touch the thread row first, or two writers can deadlock.
CREATE FUNCTION "run_events_assign_seq"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.seq <> 0 THEN
    RAISE EXCEPTION 'run_events.seq is assigned by the database; omit it' USING ERRCODE = '428C9';
  END IF;
  UPDATE "runs" SET "last_seq" = "last_seq" + 1
    WHERE "team_id" = NEW.team_id AND "id" = NEW.run_id
    RETURNING "last_seq" INTO NEW.seq;
  IF NEW.seq IS NULL THEN
    RAISE EXCEPTION 'run % not found in the active team', NEW.run_id USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "run_events_assign_seq" BEFORE INSERT ON "run_events"
  FOR EACH ROW EXECUTE FUNCTION "run_events_assign_seq"();--> statement-breakpoint

-- Per-thread entry order (D15), allocated the same way from threads.last_entry_seq.
CREATE FUNCTION "thread_entries_assign_seq"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.seq <> 0 THEN
    RAISE EXCEPTION 'thread_entries.seq is assigned by the database; omit it' USING ERRCODE = '428C9';
  END IF;
  UPDATE "threads" SET "last_entry_seq" = "last_entry_seq" + 1
    WHERE "team_id" = NEW.team_id AND "id" = NEW.thread_id
    RETURNING "last_entry_seq" INTO NEW.seq;
  IF NEW.seq IS NULL THEN
    RAISE EXCEPTION 'thread % not found in the active team', NEW.thread_id USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "thread_entries_assign_seq" BEFORE INSERT ON "thread_entries"
  FOR EACH ROW EXECUTE FUNCTION "thread_entries_assign_seq"();--> statement-breakpoint

-- seq is immutable once assigned (a rewrite would break resume); team_id/run_id moves are already
-- blocked by RLS and the foreign keys.
CREATE FUNCTION "conversations_seq_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.seq IS DISTINCT FROM OLD.seq THEN
    RAISE EXCEPTION '%.seq cannot be changed', TG_TABLE_NAME USING ERRCODE = '428C9';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "run_events_seq_immutable" BEFORE UPDATE OF "seq" ON "run_events"
  FOR EACH ROW EXECUTE FUNCTION "conversations_seq_immutable"();--> statement-breakpoint
CREATE TRIGGER "thread_entries_seq_immutable" BEFORE UPDATE OF "seq" ON "thread_entries"
  FOR EACH ROW EXECUTE FUNCTION "conversations_seq_immutable"();
