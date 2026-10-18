ALTER TABLE "threads" ADD COLUMN "skill_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "skill_draft_id" uuid;