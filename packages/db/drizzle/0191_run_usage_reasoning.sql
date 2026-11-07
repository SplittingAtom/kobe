ALTER TABLE "run_usage" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "run_usage" ADD COLUMN "reasoning_estimated" boolean DEFAULT false NOT NULL;