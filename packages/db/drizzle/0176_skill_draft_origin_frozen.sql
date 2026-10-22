-- KOBE-344: an import's origin is provenance like started_from and parent_ref: it never changes.
CREATE OR REPLACE FUNCTION "public"."skill_drafts_guard"() RETURNS trigger
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
    IF (NEW.id, NEW.owner_user_id, NEW.started_from, NEW.parent_ref, NEW.from_thread_id,
        NEW.origin, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.owner_user_id, OLD.started_from, OLD.parent_ref, OLD.from_thread_id,
        OLD.origin, OLD.created_at) THEN
      RAISE EXCEPTION 'a draft''s author and provenance never change' USING ERRCODE = '55000';
    END IF;
    IF OLD.co_edited AND NOT NEW.co_edited THEN
      RAISE EXCEPTION 'a co-edited draft stays co-edited' USING ERRCODE = '55000';
    END IF;
  END IF;
  NEW.co_edited := NEW.co_edited OR NEW.updated_by <> NEW.owner_user_id;
  RETURN NEW;
END;
$$;
