-- KOBE-564: run_usage kind `skill_manifest`, the server's call that drafts a kobe.skill.yaml for a
-- member (a server call: no sandbox) that no run triggered (a member started it from the Promote
-- panel), so its row names no run either. Custom, like 0100 and 0147, so db:rebase keeps the SQL
-- as written (drizzle cannot express NOT VALID).
--
-- NOT VALID, no VALIDATE: run_usage is the largest team table, and drizzle runs every pending
-- migration in one transaction, so validating would scan it under the DROP's ACCESS EXCLUSIVE lock
-- until commit. Every existing row passes both CHECKs by construction (the old ones were stricter
-- and held for every row since 0100/0147). The previous release's gateway writes only the kinds
-- 0147 names, which both CHECKs still accept (rolling upgrade, helm rollback).
ALTER TABLE "run_usage" DROP CONSTRAINT "run_usage_kind";--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_kind" CHECK ("run_usage"."kind" IN ('run', 'title', 'followups', 'eval', 'eval_judge', 'skill_manifest')) NOT VALID;--> statement-breakpoint
ALTER TABLE "run_usage" DROP CONSTRAINT "run_usage_kind_shape";--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_kind_shape" CHECK (("run_usage"."kind" IN ('run', 'eval') AND "run_usage"."sandbox_id" IS NOT NULL) OR ("run_usage"."kind" = 'skill_manifest' AND "run_usage"."sandbox_id" IS NULL AND "run_usage"."run_id" IS NULL) OR ("run_usage"."kind" NOT IN ('run', 'eval', 'skill_manifest') AND "run_usage"."sandbox_id" IS NULL AND "run_usage"."run_id" IS NOT NULL)) NOT VALID;
