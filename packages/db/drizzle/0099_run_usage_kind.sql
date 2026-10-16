-- Server-originated model calls (KOBE-234, CE18 titles / CE21 follow-ups; contract in
-- docs/design/server-model-calls.md). Expand-only: every existing row (and every insert from a
-- previous release's gateway during the rollout, or after `helm rollback`) is a sandbox call with a
-- sandbox id, which the constant default 'run' describes; the default is metadata-only (no
-- rewrite) and DROP NOT NULL is catalog-only. No RLS change. The kind CHECKs follow in 0100.
ALTER TABLE "run_usage" ALTER COLUMN "sandbox_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "run_usage" ADD COLUMN "kind" text DEFAULT 'run' NOT NULL;
