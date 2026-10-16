-- KOBE-234: the run_usage kind CHECKs (schema/usage.ts names them). Custom, so db:rebase keeps this
-- SQL as written (a generated migration is regenerated, which would drop NOT VALID).
--
-- NOT VALID, with no VALIDATE: drizzle runs all pending migrations in ONE transaction, and 0099's
-- ADD COLUMN holds an ACCESS EXCLUSIVE lock on run_usage (the largest team table: one row per model
-- call) until commit, so validating would scan it under that lock. The CHECKs hold for every row
-- written from now on; every existing row passes both by construction (kind is the default 'run',
-- and sandbox_id was NOT NULL until 0099).
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_kind" CHECK ("run_usage"."kind" IN ('run', 'title', 'followups')) NOT VALID;--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_kind_shape" CHECK (("run_usage"."kind" = 'run' AND "run_usage"."sandbox_id" IS NOT NULL) OR ("run_usage"."kind" <> 'run' AND "run_usage"."sandbox_id" IS NULL AND "run_usage"."run_id" IS NOT NULL)) NOT VALID;
