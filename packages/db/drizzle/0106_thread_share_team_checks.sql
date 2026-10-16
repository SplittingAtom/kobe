-- KOBE-221 (CE20): the SQL-only objects of 0105. Custom, so db:rebase keeps this SQL as written (a
-- generated migration is regenerated, which would drop NOT VALID and IF NOT EXISTS); schema/threads.ts
-- names them.
--
-- Locks: drizzle runs all pending migrations in ONE transaction, and 0105's ADD COLUMN holds an
-- ACCESS EXCLUSIVE lock on threads until commit. So the CHECK is NOT VALID, with no VALIDATE (every
-- existing row has the false default, which passes; it holds for every row written from now on). The
-- index can't be built beforehand (its column is new in this release): the build is one sequential
-- read of threads and the index starts empty (docs/install.md, "Upgrading"); IF NOT EXISTS lets a
-- re-run skip one built by hand.
--
-- One share scope at a time (private, project or team), and a builder test thread is never shared
-- (threads_test_private already refuses shared_to_project on one).
ALTER TABLE "threads" ADD CONSTRAINT "threads_share_scope" CHECK (NOT ("shared_to_project" AND "shared_to_team") AND (NOT "is_test" OR NOT "shared_to_team")) NOT VALID;--> statement-breakpoint
-- Shared with me (GET /v1/threads/shared): the team's live team-shared threads, newest activity
-- first, in the keyset order of the query. Project-shared ones come from threads_project_activity_idx.
CREATE INDEX IF NOT EXISTS "threads_team_shared_idx" ON "threads" ("team_id", "last_activity_at" DESC, "id" DESC)
  WHERE "shared_to_team" AND "deleted_at" IS NULL;
