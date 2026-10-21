ALTER TABLE "runs" DROP CONSTRAINT "runs_kind";--> statement-breakpoint
ALTER TABLE "sandbox_commands" DROP CONSTRAINT "sandbox_commands_kind";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_kind" CHECK ("runs"."kind" IN ('message', 'compaction', 'notebook'));--> statement-breakpoint
ALTER TABLE "sandbox_commands" ADD CONSTRAINT "sandbox_commands_kind" CHECK ("sandbox_commands"."kind" IN ('run.start', 'run.steer', 'run.stop', 'pi.command', 'thread.compact', 'eval.prepare', 'eval.snapshot', 'eval.read', 'notebook.execute', 'notebook.interrupt', 'notebook.restart'));