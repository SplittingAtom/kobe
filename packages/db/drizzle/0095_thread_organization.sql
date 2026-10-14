ALTER TABLE "threads" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "title_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "forked_from_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "forked_at_entry_id" text;--> statement-breakpoint
CREATE INDEX "threads_owner_pinned_idx" ON "threads" USING btree ("team_id","owner_user_id","pinned_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "threads"."pinned_at" IS NOT NULL AND "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "threads_forked_from_idx" ON "threads" USING btree ("team_id","forked_from_thread_id") WHERE "threads"."forked_from_thread_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_fork_not_self" CHECK ("threads"."forked_from_thread_id" IS DISTINCT FROM "threads"."id");--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_forked_at_entry_id_length" CHECK ("threads"."forked_at_entry_id" IS NULL OR char_length("threads"."forked_at_entry_id") BETWEEN 1 AND 128);