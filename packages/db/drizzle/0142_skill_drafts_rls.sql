-- KOBE-320 (Skills v1.2, SK11; D5, D10, D18): row security, bookkeeping, provenance and legal-hold
-- handling for the Workbench drafts of 0141_skill_drafts. Custom, so db:rebase keeps this SQL as
-- written. The tables are new and empty, so nothing is backfilled and FORCE RLS needs no lifting.
--
-- Team isolation, as in 0001_team_rls.sql: ENABLE + FORCE RLS and the canonical policy. Who in the
-- team reads or writes a draft (its author; Builders and Team admins once it is shared) is the
-- server's decision. Break-glass (D10): a private draft is team content nobody else can read, so a
-- SELECT-only break_glass_read policy shaped like agent_eval_cases' (0113): a team grant reads the
-- team's drafts and copies, a user grant those the user authored or wrote, a thread grant none.
--
-- Legal hold (D18), the KOBE-275 history pattern: a hold never refuses or shows itself. While a hold
-- covers a draft's author or a file's writer (skill_draft_held), the triggers below copy what a
-- change or deletion would lose into skill_draft_history / skill_draft_file_history, and the
-- change goes through as usual: edits, deletes, the retention purge and offboarding alike, so a held
-- draft past its window looks purged like any other. The copies are immutable, readable under
-- break-glass only, their deletion refused while a hold covers their author or writer (the
-- retention pass purges them once none does); TRUNCATE of all four tables is refused while any
-- hold is active. Every function is SECURITY INVOKER (the default): RLS applies inside them too.

ALTER TABLE "skill_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_drafts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "skill_drafts"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "skill_drafts" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND (SELECT g.thread_id FROM "public"."break_glass_active_grant"() g) IS NULL
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL
      OR "owner_user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g))
  );--> statement-breakpoint

ALTER TABLE "skill_draft_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_draft_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "skill_draft_files"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "skill_draft_files" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND (SELECT g.thread_id FROM "public"."break_glass_active_grant"() g) IS NULL
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL
      OR "updated_by" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g)
      OR EXISTS (
        SELECT 1 FROM "public"."skill_drafts" d
         WHERE d."team_id" = "skill_draft_files"."team_id" AND d."id" = "skill_draft_files"."draft_id"
           AND d."owner_user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g)))
  );--> statement-breakpoint

ALTER TABLE "skill_draft_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_draft_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "skill_draft_history"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "skill_draft_history" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND (SELECT g.thread_id FROM "public"."break_glass_active_grant"() g) IS NULL
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL
      OR "owner_user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g)
      OR "updated_by" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g))
  );--> statement-breakpoint

ALTER TABLE "skill_draft_file_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_draft_file_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "skill_draft_file_history"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "skill_draft_file_history" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND (SELECT g.thread_id FROM "public"."break_glass_active_grant"() g) IS NULL
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL
      OR "owner_user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g)
      OR "written_by" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g))
  );--> statement-breakpoint

-- Size, file count and co-editing follow the files, for every writer: each file change adds its
-- difference to the draft row (which serializes concurrent writers on that row), so
-- skill_drafts_size caps the whole draft in the database, not only in the server; a write by
-- anyone but the author marks the draft co-edited. A file's move to another draft or team is
-- refused (files are rewritten, never moved). When the draft itself is being deleted (the
-- cascade), the UPDATE finds no row and does nothing.
CREATE FUNCTION "public"."skill_draft_files_size"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  bytes_delta bigint;
  files_delta integer;
  writer uuid;
  t uuid;
  d uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.team_id, NEW.draft_id) IS DISTINCT FROM (OLD.team_id, OLD.draft_id) THEN
    RAISE EXCEPTION 'a draft file cannot move to another draft' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    bytes_delta := NEW.size; files_delta := 1; writer := NEW.updated_by;
    t := NEW.team_id; d := NEW.draft_id;
  ELSIF TG_OP = 'UPDATE' THEN
    bytes_delta := NEW.size - OLD.size; files_delta := 0; writer := NEW.updated_by;
    t := NEW.team_id; d := NEW.draft_id;
  ELSE
    bytes_delta := -OLD.size; files_delta := -1; writer := NULL;
    t := OLD.team_id; d := OLD.draft_id;
  END IF;
  UPDATE "public"."skill_drafts"
     SET "size_bytes" = "size_bytes" + bytes_delta, "file_count" = "file_count" + files_delta,
         "co_edited" = "co_edited" OR (writer IS NOT NULL AND writer <> "owner_user_id")
   WHERE "team_id" = t AND "id" = d;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_draft_files_size" AFTER INSERT OR UPDATE OR DELETE ON "skill_draft_files"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_draft_files_size"();--> statement-breakpoint

-- The draft row: the bookkeeping columns are the files trigger's alone (a draft starts empty;
-- the app never sets them itself); its author and provenance (started_from, parent_ref,
-- from_thread_id) never change, so nothing can make a forked or conversation-started draft look
-- like the author's own; co_edited turns true once anyone but the author changes it, never back.
CREATE FUNCTION "public"."skill_drafts_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.size_bytes <> 0 OR NEW.file_count <> 0 THEN
      RAISE EXCEPTION 'a draft starts without files' USING ERRCODE = '55000';
    END IF;
  ELSE
    IF pg_trigger_depth() < 2
       AND (NEW.size_bytes, NEW.file_count) IS DISTINCT FROM (OLD.size_bytes, OLD.file_count) THEN
      RAISE EXCEPTION 'a draft''s size follows its files' USING ERRCODE = '55000';
    END IF;
    IF (NEW.id, NEW.owner_user_id, NEW.started_from, NEW.parent_ref, NEW.from_thread_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.owner_user_id, OLD.started_from, OLD.parent_ref, OLD.from_thread_id, OLD.created_at) THEN
      RAISE EXCEPTION 'a draft''s author and provenance never change' USING ERRCODE = '55000';
    END IF;
    IF OLD.co_edited AND NOT NEW.co_edited THEN
      RAISE EXCEPTION 'a co-edited draft stays co-edited' USING ERRCODE = '55000';
    END IF;
  END IF;
  NEW.co_edited := NEW.co_edited OR NEW.updated_by <> NEW.owner_user_id;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_drafts_guard" BEFORE INSERT OR UPDATE ON "skill_drafts"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_drafts_guard"();--> statement-breakpoint

-- Whether a hold covers a draft's author or the writer of what is about to change.
CREATE FUNCTION "public"."skill_draft_held"(team uuid, owner uuid, writer uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT "public"."legal_hold_covers"(team, owner) OR "public"."legal_hold_covers"(team, writer)
$$;--> statement-breakpoint

-- A file's content overwritten: the old content is kept while a hold covers the draft's author or
-- its writer. An unchanged write (a retry) keeps nothing.
CREATE FUNCTION "public"."skill_draft_files_keep_overwritten"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  owner uuid;
BEGIN
  IF (NEW.path, NEW.text_content, NEW.bytes) IS NOT DISTINCT FROM (OLD.path, OLD.text_content, OLD.bytes) THEN
    RETURN NEW;
  END IF;
  PERFORM "public"."legal_hold_lock_shared"();
  SELECT d.owner_user_id INTO owner FROM "public"."skill_drafts" d
   WHERE d.team_id = OLD.team_id AND d.id = OLD.draft_id;
  IF "public"."skill_draft_held"(OLD.team_id, owner, OLD.updated_by) THEN
    INSERT INTO "public"."skill_draft_file_history"
      (team_id, draft_id, owner_user_id, written_by, path, text_content, bytes, size, change, written_at)
    VALUES (OLD.team_id, OLD.draft_id, owner, OLD.updated_by, OLD.path, OLD.text_content, OLD.bytes,
      OLD.size, 'overwritten', OLD.updated_at);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_draft_files_keep_overwritten" BEFORE UPDATE ON "skill_draft_files"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_draft_files_keep_overwritten"();--> statement-breakpoint

-- A file deleted on its own (its draft still there): kept as above. Files deleted with their draft
-- (the cascade, after the draft row is gone) were kept by skill_drafts_keep_deleted first.
CREATE FUNCTION "public"."skill_draft_files_keep_deleted"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  INSERT INTO "public"."skill_draft_file_history"
    (team_id, draft_id, owner_user_id, written_by, path, text_content, bytes, size, change, written_at)
  SELECT f.team_id, f.draft_id, d.owner_user_id, f.updated_by, f.path, f.text_content, f.bytes,
         f.size, 'deleted', f.updated_at
    FROM gone f JOIN "public"."skill_drafts" d ON d.team_id = f.team_id AND d.id = f.draft_id
   WHERE "public"."skill_draft_held"(f.team_id, d.owner_user_id, f.updated_by);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_draft_files_keep_deleted" AFTER DELETE ON "skill_draft_files"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."skill_draft_files_keep_deleted"();--> statement-breakpoint

-- A draft deleted (by its author, a purge or the team's removal): before its files go by cascade,
-- the files a hold covers (author or writer) are kept, and the draft row with them, or when a hold
-- covers its author or last writer.
CREATE FUNCTION "public"."skill_drafts_keep_deleted"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  kept integer;
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  INSERT INTO "public"."skill_draft_file_history"
    (team_id, draft_id, owner_user_id, written_by, path, text_content, bytes, size, change, written_at)
  SELECT f.team_id, f.draft_id, OLD.owner_user_id, f.updated_by, f.path, f.text_content, f.bytes,
         f.size, 'deleted', f.updated_at
    FROM "public"."skill_draft_files" f
   WHERE f.team_id = OLD.team_id AND f.draft_id = OLD.id
     AND "public"."skill_draft_held"(f.team_id, OLD.owner_user_id, f.updated_by);
  GET DIAGNOSTICS kept = ROW_COUNT;
  IF kept > 0 OR "public"."skill_draft_held"(OLD.team_id, OLD.owner_user_id, OLD.updated_by) THEN
    INSERT INTO "public"."skill_draft_history"
      (team_id, draft_id, owner_user_id, updated_by, name, shared, started_from, parent_ref,
       from_thread_id, rev, change, draft_created_at, draft_updated_at)
    VALUES (OLD.team_id, OLD.id, OLD.owner_user_id, OLD.updated_by, OLD.name, OLD.shared,
       OLD.started_from, OLD.parent_ref, OLD.from_thread_id, OLD.rev, 'deleted', OLD.created_at,
       OLD.updated_at);
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_drafts_keep_deleted" BEFORE DELETE ON "skill_drafts"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_drafts_keep_deleted"();--> statement-breakpoint

-- A draft renamed or (un)shared: the row as it was, while a hold covers its author or last writer.
CREATE FUNCTION "public"."skill_drafts_keep_changed"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.name, NEW.shared) IS NOT DISTINCT FROM (OLD.name, OLD.shared) THEN
    RETURN NEW;
  END IF;
  PERFORM "public"."legal_hold_lock_shared"();
  IF "public"."skill_draft_held"(OLD.team_id, OLD.owner_user_id, OLD.updated_by) THEN
    INSERT INTO "public"."skill_draft_history"
      (team_id, draft_id, owner_user_id, updated_by, name, shared, started_from, parent_ref,
       from_thread_id, rev, change, draft_created_at, draft_updated_at)
    VALUES (OLD.team_id, OLD.id, OLD.owner_user_id, OLD.updated_by, OLD.name, OLD.shared,
       OLD.started_from, OLD.parent_ref, OLD.from_thread_id, OLD.rev, 'changed', OLD.created_at,
       OLD.updated_at);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_drafts_keep_changed" BEFORE UPDATE OF "name", "shared" ON "skill_drafts"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_drafts_keep_changed"();--> statement-breakpoint

-- The copies: immutable, and not deleted while a hold covers their author or writer.
CREATE FUNCTION "public"."skill_draft_history_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'a legal hold''s copy of a draft is immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
-- Every column but team_id, which is left to RLS and the foreign keys (as for every team table).
CREATE TRIGGER "skill_draft_history_immutable" BEFORE UPDATE OF "id", "draft_id", "owner_user_id",
    "updated_by", "name", "shared", "started_from", "parent_ref", "from_thread_id", "rev", "change",
    "draft_created_at", "draft_updated_at", "kept_at"
  ON "skill_draft_history"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_draft_history_immutable"();--> statement-breakpoint
CREATE TRIGGER "skill_draft_file_history_immutable" BEFORE UPDATE OF "id", "draft_id", "owner_user_id",
    "written_by", "path", "text_content", "bytes", "size", "change", "written_at", "kept_at"
  ON "skill_draft_file_history"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_draft_history_immutable"();--> statement-breakpoint

CREATE FUNCTION "public"."skill_draft_history_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT g.team_id, g.owner_user_id, g.updated_by FROM gone g) k
    WHERE "public"."skill_draft_held"(k.team_id, k.owner_user_id, k.updated_by)) THEN
    RAISE EXCEPTION 'draft history under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_draft_history_legal_hold" AFTER DELETE ON "skill_draft_history"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."skill_draft_history_legal_hold_guard"();--> statement-breakpoint

CREATE FUNCTION "public"."skill_draft_file_history_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT g.team_id, g.owner_user_id, g.written_by FROM gone g) k
    WHERE "public"."skill_draft_held"(k.team_id, k.owner_user_id, k.written_by)) THEN
    RAISE EXCEPTION 'draft file history under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_draft_file_history_legal_hold" AFTER DELETE ON "skill_draft_file_history"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."skill_draft_file_history_legal_hold_guard"();--> statement-breakpoint

-- TRUNCATE skips row triggers: refused on all four tables while any hold is active.
CREATE TRIGGER "skill_drafts_legal_hold_truncate" BEFORE TRUNCATE ON "skill_drafts"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "skill_draft_files_legal_hold_truncate" BEFORE TRUNCATE ON "skill_draft_files"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "skill_draft_history_legal_hold_truncate" BEFORE TRUNCATE ON "skill_draft_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "skill_draft_file_history_legal_hold_truncate" BEFORE TRUNCATE ON "skill_draft_file_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();
