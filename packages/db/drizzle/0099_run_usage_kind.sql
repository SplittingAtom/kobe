-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- Server-originated model calls (KOBE-234, CE18 titles / CE21 follow-ups; contract in
-- docs/design/server-model-calls.md). Expand-only: every existing row (and every insert from a
-- previous release's gateway during the rollout, or after `helm rollback`) is a sandbox call with a
-- sandbox id, which the constant default 'run' describes; the default is metadata-only (no
-- rewrite) and DROP NOT NULL is catalog-only. No RLS change: run_usage keeps its team policy.
--
-- Locks: drizzle runs all pending migrations in ONE transaction, and ADD COLUMN holds an ACCESS
-- EXCLUSIVE lock on run_usage (the largest team table: one row per model call) until commit. The
-- two CHECKs are therefore NOT VALID, with no VALIDATE: no scan under that lock. They check every
-- row written from now on; every existing row passes both by construction (kind is the default
-- 'run', and sandbox_id was NOT NULL until the first statement below). Hand-written because drizzle
-- generates no NOT VALID.
ALTER TABLE "run_usage" ALTER COLUMN "sandbox_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "run_usage" ADD COLUMN "kind" text DEFAULT 'run' NOT NULL;--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_kind" CHECK ("run_usage"."kind" IN ('run', 'title', 'followups')) NOT VALID;--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_kind_shape" CHECK (("run_usage"."kind" = 'run' AND "run_usage"."sandbox_id" IS NOT NULL) OR ("run_usage"."kind" <> 'run' AND "run_usage"."sandbox_id" IS NULL AND "run_usage"."run_id" IS NOT NULL)) NOT VALID;
