-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-307 (Skills v1.2, SK3): personal skills are no longer "site" skills; the Site's catalog
-- takes that word. Every site_skill* object is renamed in place (ALTER ... RENAME: catalog only,
-- no table rewrite, no rows touched), so grants, the immutability trigger and the rows carry over.
-- No function body or policy names these tables; audit rows are never rewritten.
ALTER TABLE "site_skills" RENAME TO "personal_skills";--> statement-breakpoint
ALTER TABLE "site_skill_versions" RENAME TO "personal_skill_versions";--> statement-breakpoint
ALTER TABLE "site_skill_scans" RENAME TO "personal_skill_scans";--> statement-breakpoint
-- Constraints (a primary key or unique constraint renames its index too), then the trigger.
ALTER TABLE "personal_skills" RENAME CONSTRAINT "site_skills_pkey" TO "personal_skills_pkey";--> statement-breakpoint
ALTER TABLE "personal_skills" RENAME CONSTRAINT "site_skills_slug_unique" TO "personal_skills_slug_unique";--> statement-breakpoint
ALTER TABLE "personal_skills" RENAME CONSTRAINT "site_skills_owner_user_id_users_id_fk" TO "personal_skills_owner_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "personal_skills" RENAME CONSTRAINT "site_skills_slug_format" TO "personal_skills_slug_format";--> statement-breakpoint
ALTER TABLE "personal_skills" RENAME CONSTRAINT "site_skills_description_size" TO "personal_skills_description_size";--> statement-breakpoint
ALTER TABLE "personal_skills" RENAME CONSTRAINT "site_skills_latest_version_positive" TO "personal_skills_latest_version_positive";--> statement-breakpoint
ALTER TABLE "personal_skill_versions" RENAME CONSTRAINT "site_skill_versions_skill_id_version_pk" TO "personal_skill_versions_skill_id_version_pk";--> statement-breakpoint
ALTER TABLE "personal_skill_versions" RENAME CONSTRAINT "site_skill_versions_skill_fk" TO "personal_skill_versions_skill_fk";--> statement-breakpoint
ALTER TABLE "personal_skill_versions" RENAME CONSTRAINT "site_skill_versions_uploaded_by_users_id_fk" TO "personal_skill_versions_uploaded_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "personal_skill_versions" RENAME CONSTRAINT "site_skill_versions_version_positive" TO "personal_skill_versions_version_positive";--> statement-breakpoint
ALTER TABLE "personal_skill_versions" RENAME CONSTRAINT "site_skill_versions_frontmatter_object" TO "personal_skill_versions_frontmatter_object";--> statement-breakpoint
ALTER TABLE "personal_skill_versions" RENAME CONSTRAINT "site_skill_versions_content_hash_format" TO "personal_skill_versions_content_hash_format";--> statement-breakpoint
ALTER TABLE "personal_skill_versions" RENAME CONSTRAINT "site_skill_versions_sizes" TO "personal_skill_versions_sizes";--> statement-breakpoint
ALTER TABLE "personal_skill_scans" RENAME CONSTRAINT "site_skill_scans_skill_id_version_pk" TO "personal_skill_scans_skill_id_version_pk";--> statement-breakpoint
ALTER TABLE "personal_skill_scans" RENAME CONSTRAINT "site_skill_scans_version_fk" TO "personal_skill_scans_version_fk";--> statement-breakpoint
ALTER TRIGGER "site_skill_versions_immutable" ON "personal_skill_versions" RENAME TO "personal_skill_versions_immutable";
