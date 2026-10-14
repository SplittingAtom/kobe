-- Compaction runs (KOBE-213, CE15). Expand-only: existing rows (and inserts from a previous
-- release during the rollout, or after `helm rollback`) get kind 'message', which is what they
-- are; the constant default is metadata-only (no rewrite). The CHECKs are added NOT VALID and then
-- validated, so the scan runs without blocking reads or writes.
ALTER TABLE "runs" ADD COLUMN "kind" text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_kind" CHECK ("runs"."kind" IN ('message', 'compaction')) NOT VALID;--> statement-breakpoint
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_kind";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_compaction_shape" CHECK ("runs"."kind" = 'message' OR ("runs"."input" = '' AND "runs"."parent_entry_id" IS NULL AND "runs"."user_entry_id" IS NULL AND "runs"."retry_of_run_id" IS NULL AND "runs"."client_key" IS NULL AND "runs"."status" <> 'queued')) NOT VALID;--> statement-breakpoint
ALTER TABLE "runs" VALIDATE CONSTRAINT "runs_compaction_shape";--> statement-breakpoint
-- Widen the command kinds by 'thread.compact' (a previous release never sends it).
ALTER TABLE "sandbox_commands" DROP CONSTRAINT "sandbox_commands_kind";--> statement-breakpoint
ALTER TABLE "sandbox_commands" ADD CONSTRAINT "sandbox_commands_kind" CHECK ("sandbox_commands"."kind" IN ('run.start', 'run.steer', 'run.stop', 'pi.command', 'thread.compact')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sandbox_commands" VALIDATE CONSTRAINT "sandbox_commands_kind";
