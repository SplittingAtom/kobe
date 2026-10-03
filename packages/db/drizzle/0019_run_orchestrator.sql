ALTER TABLE "runs" ADD COLUMN "approval_mode" text DEFAULT 'ask-on-write' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "input" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "parent_entry_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "user_entry_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "retry_of_run_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "budget_stop_scope" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_retry_of_fk" FOREIGN KEY ("team_id","retry_of_run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_retry_of_unique" ON "runs" USING btree ("team_id","retry_of_run_id") WHERE "runs"."retry_of_run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_approval_mode" CHECK ("runs"."approval_mode" IN ('ask-on-write', 'ask-all', 'auto'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_input_length" CHECK (char_length("runs"."input") <= 200000);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_entry_ids" CHECK (("runs"."parent_entry_id" IS NULL OR char_length("runs"."parent_entry_id") BETWEEN 1 AND 128) AND ("runs"."user_entry_id" IS NULL OR char_length("runs"."user_entry_id") BETWEEN 1 AND 128));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_retry_not_self" CHECK ("runs"."retry_of_run_id" IS NULL OR "runs"."retry_of_run_id" <> "runs"."id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_budget_stop_scope" CHECK ("runs"."budget_stop_scope" IS NULL OR "runs"."budget_stop_scope" IN ('install', 'team', 'user'));