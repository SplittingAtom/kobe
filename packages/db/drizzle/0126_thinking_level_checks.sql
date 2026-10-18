-- KOBE-260: the SQL-only objects of 0125. Custom, so db:rebase keeps this SQL as written (a
-- generated migration is regenerated, which would drop NOT VALID); schema/threads.ts and
-- schema/runs.ts name them.
--
-- Locks: drizzle runs all pending migrations in ONE transaction, and 0125's ADD COLUMN holds an
-- ACCESS EXCLUSIVE lock on threads and runs until commit. So the CHECKs are NOT VALID, with no
-- VALIDATE (every existing row is NULL, which passes; they hold for every row written from now on).
--
-- A conversation's chosen thinking level and a run's effective one: a level or null.
ALTER TABLE "threads" ADD CONSTRAINT "threads_thinking_level" CHECK ("thinking_level" IS NULL OR "thinking_level" IN ('off', 'low', 'medium', 'high')) NOT VALID;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_thinking_level" CHECK ("thinking_level" IS NULL OR "thinking_level" IN ('off', 'low', 'medium', 'high')) NOT VALID;
