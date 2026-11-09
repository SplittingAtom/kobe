-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-577 (Workspaces MG2, MG3, MG4, MG0): the data half of the Workspaces schema, after 0199
-- added projects.visibility and the commit tables and 0200 put them under RLS. Drizzle generated
-- the schema statements here (drop members_mode, the new role check and default); the backfills
-- between them are hand-written, because generated SQL would drop members_mode before reading it.
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS) and every table touched has FORCE
-- ROW LEVEL SECURITY with no `kobe.team_id` set, so FORCE is lifted for the backfill only (one
-- transaction; ALTER TABLE holds its lock until commit, so nothing else sees a table without it),
-- as 0159. (workspaces-upgrade.db.test.ts migrates a populated database.)
ALTER TABLE "projects" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_members" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_files" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_commits" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_tree_entries" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- MG3: roles owner | editor | reader; the members an owner listed by hand become editors.
ALTER TABLE "project_members" DROP CONSTRAINT "project_members_role";--> statement-breakpoint
UPDATE "project_members" SET "role" = 'editor' WHERE "role" = 'member';--> statement-breakpoint
ALTER TABLE "project_members" ALTER COLUMN "role" SET DEFAULT 'editor';--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_role" CHECK ("project_members"."role" IN ('owner', 'editor', 'reader'));--> statement-breakpoint

-- MG2: visibility from members_mode (team -> workspace, selected -> restricted); members_mode goes
-- in the same migration (MG0: no compatibility column).
UPDATE "projects" SET "visibility" = CASE WHEN "members_mode" = 'selected' THEN 'restricted' ELSE 'workspace' END;--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_members_mode";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "members_mode";--> statement-breakpoint

-- MG4: commit 1 "Imported" for every project with files, by its creator, with the tree from
-- project_files; head_commit_id and the live counters set. Projects without files keep a null
-- head. Blob keys stay where they are (files/<id>); one key per file, so live objects = files.
-- The commit is dated by the project's newest file (when its tree last changed).
INSERT INTO "project_commits" ("team_id", "project_id", "seq", "author_user_id", "author_kind", "message", "file_count", "bytes", "created_at")
SELECT p."team_id", p."id", 1, p."created_by", 'user', 'Imported', count(*)::integer, sum(f."size_bytes"),
       COALESCE(max(f."added_at"), now())
  FROM "projects" p
  JOIN "project_files" f ON f."team_id" = p."team_id" AND f."project_id" = p."id"
 GROUP BY p."team_id", p."id", p."created_by";--> statement-breakpoint
INSERT INTO "project_tree_entries" ("team_id", "commit_id", "path", "sha256", "blob_ref", "size_bytes", "mime_type")
SELECT c."team_id", c."id", f."path", f."sha256", f."blob_ref", f."size_bytes", f."mime_type"
  FROM "project_commits" c
  JOIN "project_files" f ON f."team_id" = c."team_id" AND f."project_id" = c."project_id"
 WHERE c."seq" = 1;--> statement-breakpoint
UPDATE "projects" p
   SET "head_commit_id" = c."id",
       "live_bytes" = c."bytes",
       "live_objects" = (SELECT count(DISTINCT f."blob_ref")::integer FROM "project_files" f
                          WHERE f."team_id" = p."team_id" AND f."project_id" = p."id")
  FROM "project_commits" c
 WHERE c."team_id" = p."team_id" AND c."project_id" = p."id" AND c."seq" = 1;--> statement-breakpoint

ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_commits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_tree_entries" FORCE ROW LEVEL SECURITY;
