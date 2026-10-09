-- Team isolation, break-glass read and legal-hold guards for the project tables (KOBE-160, spec
-- D5, D10, D18, D23): the canonical policy as in 0005_conversations_rls.sql.
--
-- Break-glass (D5 "Install admins cannot read team content (threads, files, memory, artifacts)
-- except through break-glass"; D10): project_files is team content (files), so it gets a
-- SELECT-only break_glass_read policy, shaped like memory_docs' (0074): a team grant reads all of
-- the team's project files; a user grant reads the files that user added (added_by); a thread
-- grant reads none (project files belong to no thread). projects (name, slug, description,
-- instructions, default agent) and project_members are configuration and membership, like agents
-- and team_memory_settings: D5 lists no such object as content, and the instructions are written
-- to be shared with every member; they keep only the team policy. Widening that is one policy.
--
-- Legal hold (D18): project files have no single owner and are shared, so any active hold in the
-- team covers them (the same conservative rule as project memory, memory_legal_hold_covers from
-- 0074 with a NULL owner). Deleting held project files, including by the cascade of a project
-- delete, or truncating the table, is refused. projects and project_members hold no content.

ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "projects"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "project_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "project_members"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "project_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "project_files"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "project_files" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND (SELECT g.thread_id FROM "public"."break_glass_active_grant"() g) IS NULL
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL
      OR "added_by" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g))
  );--> statement-breakpoint
CREATE FUNCTION "public"."project_files_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id FROM gone d) g
    WHERE "public"."memory_legal_hold_covers"(g.team_id, NULL)) THEN
    RAISE EXCEPTION 'project files under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "project_files_legal_hold" AFTER DELETE ON "project_files"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."project_files_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "project_files_legal_hold_truncate" BEFORE TRUNCATE ON "project_files"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();
