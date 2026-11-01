-- KOBE-534 (spec TF1, TF2): the SQL-only objects of 0186. Custom, so db:rebase keeps this SQL as
-- written (a generated migration is regenerated, which would drop NOT VALID and IF NOT EXISTS);
-- schema/thread-folders.ts and schema/threads.ts name them.
--
-- Locks: drizzle runs all pending migrations in ONE transaction, and 0186's ADD COLUMN holds an
-- ACCESS EXCLUSIVE lock on threads until commit. So the CHECK is NOT VALID, with no VALIDATE (every
-- existing row has folder_id NULL, which passes; it holds for every row written from now on), the
-- key is validated over an all-null column, and the index is IF NOT EXISTS: on a large site, build
-- it beforehand with CREATE INDEX CONCURRENTLY and this definition (docs/install.md, "Upgrading"),
-- and this statement then skips it. thread_folders is new and empty: FORCE RLS needs no lifting.
--
-- Team isolation: the canonical policy, as in 0005_conversations_rls.sql. No break_glass_read
-- policy: a folder holds no content (a break-glass reader gets the thread without its folder name).
ALTER TABLE "thread_folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "thread_folders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "thread_folders"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
-- Names are unique among siblings ignoring case; NULLS NOT DISTINCT makes top-level names (parent
-- NULL) unique too (PostgreSQL 15+; the chart and CI run 17). drizzle cannot express it.
CREATE UNIQUE INDEX "thread_folders_name_unique" ON "thread_folders" ("team_id", "parent_id", lower("name"))
  NULLS NOT DISTINCT;--> statement-breakpoint
-- The tree: at most three levels counting the folder itself (THREAD_FOLDER_MAX_DEPTH), and never a
-- cycle. Checked on every insert and every change of parent_id: the new parent's chain of
-- ancestors (which reaches the folder itself if the move would close a cycle) plus the height of
-- the folder's own subtree (a moved folder takes its subfolders along). A per-team transaction
-- advisory lock serializes tree changes, so two concurrent moves cannot together form a cycle or
-- an over-deep chain that neither saw alone (the server's create takes the same lock for the
-- per-team limit). Cascaded deletes do not fire it.
CREATE FUNCTION "public"."thread_folders_guard_parent"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  cur uuid := NEW.parent_id;
  depth integer := 1;
  height integer := 1;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('kobe.thread_folders:' || NEW.team_id::text, 0));
  WHILE cur IS NOT NULL LOOP
    IF cur = NEW.id THEN
      RAISE EXCEPTION 'a thread folder cannot be moved inside itself' USING ERRCODE = 'KF002';
    END IF;
    depth := depth + 1;
    IF depth > 3 THEN
      RAISE EXCEPTION 'thread folders nest at most 3 levels deep' USING ERRCODE = 'KF001';
    END IF;
    SELECT f.parent_id INTO cur FROM "public"."thread_folders" f
      WHERE f.team_id = NEW.team_id AND f.id = cur;
    IF NOT FOUND THEN
      EXIT; -- the foreign key refuses a missing parent
    END IF;
  END LOOP;
  IF TG_OP = 'UPDATE' THEN
    WITH RECURSIVE sub(id, level) AS (
      SELECT f.id, 2 FROM "public"."thread_folders" f
        WHERE f.team_id = NEW.team_id AND f.parent_id = NEW.id
      UNION ALL
      SELECT f.id, s.level + 1 FROM "public"."thread_folders" f
        JOIN sub s ON f.team_id = NEW.team_id AND f.parent_id = s.id
        WHERE s.level < 4
    )
    SELECT coalesce(max(level), 1) INTO height FROM sub;
  END IF;
  IF depth - 1 + height > 3 THEN
    RAISE EXCEPTION 'thread folders nest at most 3 levels deep' USING ERRCODE = 'KF001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "thread_folders_guard_parent" BEFORE INSERT OR UPDATE OF "parent_id" ON "thread_folders"
  FOR EACH ROW EXECUTE FUNCTION "public"."thread_folders_guard_parent"();--> statement-breakpoint
-- A thread's folder (TF2): per team, like threads_schedule_fk (0087). Deleting a folder (or its
-- parent's cascade) clears only folder_id: the column list limits SET NULL to it, because team_id
-- is NOT NULL and part of threads' key. The SET NULL lookup reads the team's threads by key prefix
-- (threads_folder_idx skips Trash, so it cannot serve it); folder deletes are rare.
ALTER TABLE "threads" ADD CONSTRAINT "threads_folder_fk"
  FOREIGN KEY ("team_id", "folder_id") REFERENCES "public"."thread_folders" ("team_id", "id")
  ON DELETE SET NULL ("folder_id");--> statement-breakpoint
-- A builder test thread (is_test), Workbench test chat (skill_test) or eval thread (skill_eval) is
-- never filed.
ALTER TABLE "threads" ADD CONSTRAINT "threads_folder_not_test"
  CHECK ("folder_id" IS NULL OR NOT ("is_test" OR "skill_test" OR "skill_eval")) NOT VALID;--> statement-breakpoint
-- A folder's live threads by recent activity (GET /v1/threads?folder=, the folder counts).
CREATE INDEX IF NOT EXISTS "threads_folder_idx" ON "threads" ("team_id", "folder_id", "last_activity_at" DESC, "id" DESC)
  WHERE "folder_id" IS NOT NULL AND "deleted_at" IS NULL;
