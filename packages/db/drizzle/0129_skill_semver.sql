CREATE TYPE "public"."skill_access" AS ENUM('available', 'default_on', 'required', 'hidden');--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ADD COLUMN "semver" text;--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ADD COLUMN "seq" integer;--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ADD COLUMN "changelog" text;--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ADD COLUMN "package_hash" text;--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD COLUMN "semver" text;--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD COLUMN "seq" integer;--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD COLUMN "changelog" text;--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD COLUMN "package_hash" text;--> statement-breakpoint
ALTER TABLE "team_skills" ADD COLUMN "access" "skill_access" DEFAULT 'available' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_skills" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ADD CONSTRAINT "personal_skill_versions_semver_unique" UNIQUE("skill_id","semver");--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD CONSTRAINT "team_skill_versions_semver_unique" UNIQUE("team_id","skill_id","semver");--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ADD CONSTRAINT "personal_skill_versions_package_hash_format" CHECK ("personal_skill_versions"."package_hash" IS NULL OR "personal_skill_versions"."package_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ADD CONSTRAINT "personal_skill_versions_changelog_size" CHECK ("personal_skill_versions"."changelog" IS NULL OR char_length("personal_skill_versions"."changelog") BETWEEN 1 AND 1024);--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD CONSTRAINT "team_skill_versions_package_hash_format" CHECK ("team_skill_versions"."package_hash" IS NULL OR "team_skill_versions"."package_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD CONSTRAINT "team_skill_versions_changelog_size" CHECK ("team_skill_versions"."changelog" IS NULL OR char_length("team_skill_versions"."changelog") BETWEEN 1 AND 1024);