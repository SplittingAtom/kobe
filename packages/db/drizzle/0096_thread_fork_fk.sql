-- Fork provenance (KOBE-215, CE16). A fork names its source as (team_id, forked_from_thread_id),
-- so the key can never reach another team's thread. Purging the source (retention, Trash purge,
-- Delete forever, team deletion) keeps the fork and only clears the link: the column list limits
-- SET NULL to forked_from_thread_id, because team_id is NOT NULL and part of threads' key
-- (PostgreSQL 15+; the chart and CI run 17). forked_at_entry_id is provenance text and stays.
-- drizzle cannot express the column list, hence SQL-only (like threads_schedule_fk, 0087).
-- Validating the key reads threads once; the column is new and all null, so nothing can fail.
-- threads_forked_from_idx (0095) serves the SET NULL lookup on every purge.
ALTER TABLE "threads" ADD CONSTRAINT "threads_forked_from_fk"
  FOREIGN KEY ("team_id", "forked_from_thread_id") REFERENCES "threads" ("team_id", "id")
  ON DELETE SET NULL ("forked_from_thread_id");--> statement-breakpoint
-- The link is written once, at INSERT (KOBE-216 forks), and afterwards only cleared: by this
-- key's SET NULL when the source goes, or by an UPDATE to NULL. Re-pointing it is refused, so
-- provenance chains can never form a cycle (threads_fork_not_self stops only A -> A).
CREATE FUNCTION "public"."threads_guard_forked_from"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.forked_from_thread_id IS NOT NULL
     AND NEW.forked_from_thread_id IS DISTINCT FROM OLD.forked_from_thread_id THEN
    RAISE EXCEPTION 'threads.forked_from_thread_id is set when the thread is created; it can only be cleared'
      USING ERRCODE = '428C9';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "threads_guard_forked_from" BEFORE UPDATE OF "forked_from_thread_id" ON "threads"
  FOR EACH ROW EXECUTE FUNCTION "public"."threads_guard_forked_from"();
