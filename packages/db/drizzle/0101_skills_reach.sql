ALTER TABLE "runs" ADD COLUMN "skill_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "skills_used" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "team_skills" ADD COLUMN "offer_to_all" boolean DEFAULT false NOT NULL;