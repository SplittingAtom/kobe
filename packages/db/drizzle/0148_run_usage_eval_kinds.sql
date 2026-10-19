-- KOBE-326 (SK17): run_usage kinds for skill evals. `eval_judge` is the server's judge call after
-- an eval execution's run (a server call: no sandbox, its run named, like titles); `eval` is an
-- eval sandbox's own calls (a sandbox call, like `run`; KOBE-327 starts writing it). Custom, like
-- 0100, so db:rebase keeps the SQL as written (drizzle cannot express NOT VALID).
--
-- NOT VALID, no VALIDATE: run_usage is the largest team table, and drizzle runs every pending
-- migration in one transaction, so validating would scan it under the DROP's ACCESS EXCLUSIVE lock
-- until commit. Every existing row passes both CHECKs by construction (the old ones were stricter
-- and held for every row since 0100). The previous release's gateway writes only run, title and
-- followups rows, which both CHECKs still accept (rolling upgrade, helm rollback).
ALTER TABLE "run_usage" DROP CONSTRAINT "run_usage_kind";--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_kind" CHECK ("run_usage"."kind" IN ('run', 'title', 'followups', 'eval', 'eval_judge')) NOT VALID;--> statement-breakpoint
ALTER TABLE "run_usage" DROP CONSTRAINT "run_usage_kind_shape";--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_kind_shape" CHECK (("run_usage"."kind" IN ('run', 'eval') AND "run_usage"."sandbox_id" IS NOT NULL) OR ("run_usage"."kind" NOT IN ('run', 'eval') AND "run_usage"."sandbox_id" IS NULL AND "run_usage"."run_id" IS NOT NULL)) NOT VALID;
