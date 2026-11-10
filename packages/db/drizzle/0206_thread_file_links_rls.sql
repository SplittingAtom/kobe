-- KOBE-610 (spec thread-file-map §3): team isolation for thread_file_links (0205), and the triggers
-- that keep links current when files move or go away. Custom, so db:rebase keeps this SQL as
-- written. The canonical policy, as in 0189_thread_branch_labels_rls.sql; the table is new and
-- empty. No break_glass_read policy: links are derived from entries a break-glass reader already
-- gets with the thread.
ALTER TABLE "thread_file_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "thread_file_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "thread_file_links"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Moves rewrite paths. One function for a file (`p_dir` false: the path itself) or a folder (every
-- path under it, and a link to the folder itself). Rows already at the new path are merged (counts
-- added, first/last widened); a rewritten path past the column's limit is dropped. Invoker rights
-- (RLS applies; the caller's `withTeam` names the team), pinned search_path.
CREATE FUNCTION "public"."thread_file_links_move"(
  p_team uuid, p_owner uuid, p_from text, p_to text, p_dir boolean
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_from = p_to THEN RETURN; END IF;
  INSERT INTO public.thread_file_links
    (team_id, thread_id, owner_user_id, path, access, first_at, last_at, count, deleted_at)
  SELECT l.team_id, l.thread_id, l.owner_user_id, m.path, l.access, l.first_at, l.last_at, l.count,
         NULL
    FROM public.thread_file_links l
    CROSS JOIN LATERAL (SELECT CASE WHEN l.path = p_from THEN p_to
                                    ELSE p_to || substr(l.path, char_length(p_from) + 1) END
                                 AS path) m
   WHERE l.team_id = p_team AND l.owner_user_id = p_owner
     AND (l.path = p_from OR (p_dir AND left(l.path, char_length(p_from) + 1) = p_from || '/'))
     AND octet_length(m.path) <= 1024
  ON CONFLICT ON CONSTRAINT thread_file_links_key DO UPDATE SET
    first_at = LEAST(thread_file_links.first_at, EXCLUDED.first_at),
    last_at = GREATEST(thread_file_links.last_at, EXCLUDED.last_at),
    count = LEAST(thread_file_links.count::int8 + EXCLUDED.count, 2147483647)::int4,
    deleted_at = NULL;
  DELETE FROM public.thread_file_links l
   WHERE l.team_id = p_team AND l.owner_user_id = p_owner
     AND (l.path = p_from OR (p_dir AND left(l.path, char_length(p_from) + 1) = p_from || '/'));
END;
$$;--> statement-breakpoint

-- A workspace file's tombstone: moved (`moved_to`, a server move or a rename the sandbox pushed)
-- or deleted (links kept, marked). A live row (new, restored, moved in) clears the mark.
CREATE FUNCTION "public"."thread_file_links_follow_workspace"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.deleted AND NEW.moved_to IS NOT NULL THEN
    PERFORM public.thread_file_links_move(NEW.team_id, NEW.user_id, NEW.path, NEW.moved_to, false);
  ELSIF NEW.deleted THEN
    UPDATE public.thread_file_links SET deleted_at = now()
     WHERE team_id = NEW.team_id AND owner_user_id = NEW.user_id AND path = NEW.path
       AND deleted_at IS NULL;
  ELSE
    UPDATE public.thread_file_links SET deleted_at = NULL
     WHERE team_id = NEW.team_id AND owner_user_id = NEW.user_id AND path = NEW.path
       AND deleted_at IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "thread_file_links_workspace_insert" AFTER INSERT ON "workspace_files"
  FOR EACH ROW EXECUTE FUNCTION "public"."thread_file_links_follow_workspace"();--> statement-breakpoint
CREATE TRIGGER "thread_file_links_workspace_update" AFTER UPDATE OF "deleted", "moved_to"
  ON "workspace_files" FOR EACH ROW
  WHEN (OLD."deleted" IS DISTINCT FROM NEW."deleted" OR OLD."moved_to" IS DISTINCT FROM NEW."moved_to")
  EXECUTE FUNCTION "public"."thread_file_links_follow_workspace"();--> statement-breakpoint

-- A folder move (the move journal, KOBE-304) also carries links to the folder itself and to files
-- whose tombstones were already trimmed. A file move is handled twice; the second finds nothing.
CREATE FUNCTION "public"."thread_file_links_follow_move"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.thread_file_links_move(NEW.team_id, NEW.user_id, NEW.from_path, NEW.to_path,
                                        NEW.type = 'dir');
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "thread_file_links_workspace_move" AFTER INSERT ON "workspace_moves"
  FOR EACH ROW EXECUTE FUNCTION "public"."thread_file_links_follow_move"();--> statement-breakpoint

-- Project files: a removed file marks its links deleted, an added one clears the mark. A project
-- being deleted takes its links with it (the project key cascades), so they are left alone.
CREATE FUNCTION "public"."thread_file_links_follow_project"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.projects p
                    WHERE p.team_id = OLD.team_id AND p.id = OLD.project_id) THEN
      RETURN NULL;
    END IF;
    UPDATE public.thread_file_links SET deleted_at = now()
     WHERE team_id = OLD.team_id AND project_id = OLD.project_id AND path = OLD.path
       AND deleted_at IS NULL;
  ELSE
    UPDATE public.thread_file_links SET deleted_at = NULL
     WHERE team_id = NEW.team_id AND project_id = NEW.project_id AND path = NEW.path
       AND deleted_at IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "thread_file_links_project_files" AFTER INSERT OR DELETE ON "project_files"
  FOR EACH ROW EXECUTE FUNCTION "public"."thread_file_links_follow_project"();
