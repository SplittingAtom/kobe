-- KOBE-220 (CE19): the SQL-only objects of 0103. Custom, so db:rebase keeps this SQL as written (a
-- generated migration is regenerated, which would drop NOT VALID and IF NOT EXISTS); schema/threads.ts
-- names them.
--
-- Locks: drizzle runs all pending migrations in ONE transaction, and 0103's ADD COLUMN holds an
-- ACCESS EXCLUSIVE lock on threads until commit. So the CHECK is NOT VALID, with no VALIDATE (every
-- existing row is the '[]' default, which passes; it holds for every row written from now on), and
-- the index is IF NOT EXISTS: on a large site, build it beforehand with CREATE INDEX CONCURRENTLY and
-- this definition (docs/install.md, "Upgrading"), and this statement then skips it.
--
-- The shape: a JSON array of at most 20 moves (THREAD_PROJECT_MOVES_MAX, schema/threads.ts), so the
-- column stays bounded whatever writes it.
ALTER TABLE "threads" ADD CONSTRAINT "threads_project_moves_shape" CHECK (jsonb_typeof("project_moves") = 'array' AND jsonb_array_length("project_moves") <= 20) NOT VALID;--> statement-breakpoint
-- The rail's Archived group (GET /v1/threads/archived): the owner's archived live threads, newest
-- first. NULLS LAST as the query orders, so the scan needs no sort (EXPLAIN in docs/ledger/KOBE-220.md).
CREATE INDEX IF NOT EXISTS "threads_owner_archived_idx" ON "threads" ("team_id", "owner_user_id", "archived_at" DESC NULLS LAST, "id" DESC NULLS LAST)
  WHERE "archived_at" IS NOT NULL AND "deleted_at" IS NULL;
