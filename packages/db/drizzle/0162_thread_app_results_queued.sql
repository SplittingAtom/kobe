ALTER TABLE "thread_app_results" ADD COLUMN "opened_by" uuid;--> statement-breakpoint
ALTER TABLE "thread_app_results" ADD COLUMN "card_text" text;--> statement-breakpoint
ALTER TABLE "thread_app_results" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "thread_app_results" ADD CONSTRAINT "thread_app_results_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_app_results" ADD CONSTRAINT "thread_app_results_queued" CHECK (("thread_app_results"."queued_at" IS NULL OR ("thread_app_results"."entry_id" IS NOT NULL AND "thread_app_results"."card_text" IS NOT NULL))
        AND ("thread_app_results"."card_text" IS NULL OR char_length("thread_app_results"."card_text") <= 16384)
        AND ("thread_app_results"."opened_by" IS NULL OR "thread_app_results"."entry_id" IS NOT NULL));