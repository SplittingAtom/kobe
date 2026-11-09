-- KOBE-577 (Workspaces CM1, D18, §13): team isolation, the SQL-only keys and the legal-hold guards
-- for project_commits, project_tree_entries and project_checkouts (0199). Custom, so db:rebase keeps
-- this SQL as written. The canonical policy, as in 0078_projects_rls.sql; the tables are new and
-- empty. No break_glass_read policy (as projects and project_members): commit metadata and trees
-- name files, their content stays in S3 and project_files keeps its own break-glass read.
ALTER TABLE "project_commits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_commits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "project_commits"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "project_tree_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_tree_entries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "project_tree_entries"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "project_checkouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_checkouts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "project_checkouts"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Keys drizzle cannot express (PostgreSQL 15+ column lists; the chart and CI run 17), as 0096.
-- Both point at project_commits_project_commit_unique (team_id, project_id, id), so a head or a
-- parent can never name another project's commit (nor another team's).
-- The head: a project's head commit can't be deleted (GV3 pruning never removes it). NO ACTION
-- is checked at the end of the statement, so deleting a project (which cascades to its commits)
-- still works.
ALTER TABLE "projects" ADD CONSTRAINT "projects_head_commit_fk"
  FOREIGN KEY ("team_id", "id", "head_commit_id")
  REFERENCES "project_commits" ("team_id", "project_id", "id");--> statement-breakpoint
-- The parent: pruning removes the oldest commits; the oldest one kept loses its parent link.
ALTER TABLE "project_commits" ADD CONSTRAINT "project_commits_parent_fk"
  FOREIGN KEY ("team_id", "project_id", "parent_id")
  REFERENCES "project_commits" ("team_id", "project_id", "id")
  ON DELETE SET NULL ("parent_id");--> statement-breakpoint
-- The conversation an agent commit came from: history outlives it (purge clears the link).
ALTER TABLE "project_commits" ADD CONSTRAINT "project_commits_thread_fk"
  FOREIGN KEY ("team_id", "thread_id") REFERENCES "threads" ("team_id", "id")
  ON DELETE SET NULL ("thread_id");--> statement-breakpoint
ALTER TABLE "project_commits" ADD CONSTRAINT "project_commits_run_fk"
  FOREIGN KEY ("team_id", "run_id") REFERENCES "runs" ("team_id", "id")
  ON DELETE SET NULL ("run_id");--> statement-breakpoint

-- Legal hold (D18, GV3): commit history is team content shared by the project like its files, so
-- any active hold in the team covers it (project_files' rule, 0078: memory_legal_hold_covers with
-- a NULL owner). Deleting held commits or tree entries, by pruning or by the cascade of a project
-- delete, or truncating either table, is refused. Checkouts hold no content.
CREATE FUNCTION "public"."project_history_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id FROM gone d) g
    WHERE "public"."memory_legal_hold_covers"(g.team_id, NULL)) THEN
    RAISE EXCEPTION 'project history under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "project_commits_legal_hold" AFTER DELETE ON "project_commits"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."project_history_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "project_commits_legal_hold_truncate" BEFORE TRUNCATE ON "project_commits"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "project_tree_entries_legal_hold" AFTER DELETE ON "project_tree_entries"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."project_history_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "project_tree_entries_legal_hold_truncate" BEFORE TRUNCATE ON "project_tree_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();
