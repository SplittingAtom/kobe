ALTER TABLE "runs" ADD COLUMN "sandbox_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_sandbox_bytes" CHECK ("runs"."sandbox_bytes" >= 0);