-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-587 (projects-in-conversations RV1, RV2; replaces Workspaces PR2): every workspace member
-- reads every project. Restricted projects become readable by all (projects.visibility and its
-- check go), explicit `reader` rows are deleted (they no longer change anything) and
-- project_members.role is checked IN ('owner','editor'). Drizzle generated the schema statements;
-- the DELETE between them is hand-written, because it must run before the new check.
-- `kobe projects restricted` lists what becomes visible before this runs (docs/install.md, Upgrade notes).
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS) and project_members has FORCE ROW
-- LEVEL SECURITY with no `kobe.team_id` set, so FORCE is lifted for the delete only (one
-- transaction; ALTER TABLE holds its lock until commit), as 0201.
-- (restricted-removal-upgrade.db.test.ts migrates a populated database.)
ALTER TABLE "project_members" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_members" DROP CONSTRAINT "project_members_role";--> statement-breakpoint
DELETE FROM "project_members" WHERE "role" = 'reader';--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_role" CHECK ("project_members"."role" IN ('owner', 'editor'));--> statement-breakpoint
ALTER TABLE "project_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_visibility";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "visibility";
