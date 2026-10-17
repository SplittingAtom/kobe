ALTER TABLE "orbit_evals" ADD COLUMN "case_skips" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "orbit_evals" ADD COLUMN "cases_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_eval_cases" ADD COLUMN "hidden_at" timestamp with time zone;