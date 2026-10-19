-- KOBE-323 (SK13): the SQL-only objects of 0143. Custom, so db:rebase keeps this SQL as written;
-- schema/threads.ts names them.
--
-- Locks: 0143's ADD COLUMN holds ACCESS EXCLUSIVE on threads until the migration transaction
-- commits, so nothing here scans the table: every existing row has skill_test = false and
-- skill_draft_id = NULL, which passes each constraint, so they are NOT VALID with no VALIDATE (they
-- hold for every row written from now on). The index is IF NOT EXISTS: on a large site, build it
-- beforehand with CREATE INDEX CONCURRENTLY and this definition (docs/install.md, "Upgrading").
--
-- A test chat's draft is one of the thread's own team: (team_id, skill_draft_id) → skill_drafts.
-- Deleting the draft clears only skill_draft_id (team_id is NOT NULL and part of the key); the
-- thread stays a test chat, and its runs refuse.
ALTER TABLE "threads" ADD CONSTRAINT "threads_skill_draft_fk"
  FOREIGN KEY ("team_id", "skill_draft_id") REFERENCES "skill_drafts" ("team_id", "id")
  ON DELETE SET NULL ("skill_draft_id") NOT VALID;--> statement-breakpoint
-- A draft is named only by a test chat; a test chat is never also a builder test thread (KOBE-85).
ALTER TABLE "threads" ADD CONSTRAINT "threads_skill_draft_test"
  CHECK ("skill_draft_id" IS NULL OR "skill_test") NOT VALID;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_skill_test_not_builder"
  CHECK (NOT ("skill_test" AND "is_test")) NOT VALID;--> statement-breakpoint
-- The SET NULL above looks threads up by draft on every draft delete; the Workbench group too.
CREATE INDEX IF NOT EXISTS "threads_skill_draft_idx" ON "threads" ("team_id", "skill_draft_id")
  WHERE "skill_draft_id" IS NOT NULL;
