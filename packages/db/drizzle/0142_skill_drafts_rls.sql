-- KOBE-320 (Skills v1.2, SK11): row security and the size bookkeeping for the Workbench drafts of
-- 0141_skill_drafts. Custom, so db:rebase keeps this SQL as written. The tables are new and empty,
-- so nothing is backfilled and FORCE RLS needs no lifting.
--
-- Team isolation, as in 0001_team_rls.sql: ENABLE + FORCE RLS and the canonical policy. Who in the
-- team reads or writes a draft (its author; Builders and Team admins once it is shared) is the
-- server's decision. No break-glass read: drafts are skill sources, like team_skills, not thread
-- or memory content.
ALTER TABLE "skill_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_drafts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "skill_drafts"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "skill_draft_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_draft_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "skill_draft_files"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
-- The draft's size and file count follow its files, for every writer: each file change adds its
-- difference to the draft row (which serializes concurrent writers on that row), so
-- skill_drafts_size caps the whole draft at 5 MiB in the database, not only in the server. A
-- file's move to another draft or team is refused (files are rewritten, never moved). When the
-- draft itself is being deleted (the cascade), the UPDATE finds no row and does nothing.
-- SECURITY INVOKER (the default), as every Kobe function: RLS applies to the UPDATE too.
CREATE FUNCTION "public"."skill_draft_files_size"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  bytes_delta bigint;
  files_delta integer;
  t uuid;
  d uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.team_id, NEW.draft_id) IS DISTINCT FROM (OLD.team_id, OLD.draft_id) THEN
    RAISE EXCEPTION 'a draft file cannot move to another draft' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    bytes_delta := NEW.size; files_delta := 1; t := NEW.team_id; d := NEW.draft_id;
  ELSIF TG_OP = 'UPDATE' THEN
    bytes_delta := NEW.size - OLD.size; files_delta := 0; t := NEW.team_id; d := NEW.draft_id;
  ELSE
    bytes_delta := -OLD.size; files_delta := -1; t := OLD.team_id; d := OLD.draft_id;
  END IF;
  UPDATE "public"."skill_drafts"
     SET "size_bytes" = "size_bytes" + bytes_delta, "file_count" = "file_count" + files_delta
   WHERE "team_id" = t AND "id" = d;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_draft_files_size" AFTER INSERT OR UPDATE OR DELETE ON "skill_draft_files"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_draft_files_size"();--> statement-breakpoint
-- The bookkeeping columns are the trigger's alone: a draft starts empty and the app never sets
-- them itself (an INSERT with other values, or an UPDATE of them outside the trigger, is refused).
CREATE FUNCTION "public"."skill_drafts_size_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.size_bytes <> 0 OR NEW.file_count <> 0 THEN
      RAISE EXCEPTION 'a draft starts without files' USING ERRCODE = '55000';
    END IF;
  ELSIF pg_trigger_depth() < 2
     AND (NEW.size_bytes, NEW.file_count) IS DISTINCT FROM (OLD.size_bytes, OLD.file_count) THEN
    RAISE EXCEPTION 'a draft''s size follows its files' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "skill_drafts_size_guard" BEFORE INSERT OR UPDATE ON "skill_drafts"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_drafts_size_guard"();
