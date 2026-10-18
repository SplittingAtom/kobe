ALTER TABLE "users" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "tool_rules" ADD COLUMN "remember_scope" text;--> statement-breakpoint
ALTER TABLE "tool_rules" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_rules" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "tool_rules" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_rules" ADD CONSTRAINT "tool_rules_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_rules" ADD CONSTRAINT "tool_rules_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_rules_thread_idx" ON "tool_rules" USING btree ("team_id","thread_id") WHERE "tool_rules"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tool_rules_run_idx" ON "tool_rules" USING btree ("team_id","run_id") WHERE "tool_rules"."run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_time_zone" CHECK ("users"."time_zone" IS NULL OR char_length("users"."time_zone") BETWEEN 1 AND 64);