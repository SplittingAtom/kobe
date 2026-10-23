ALTER TYPE "public"."registry_publisher" ADD VALUE 'site';--> statement-breakpoint
CREATE TABLE "site_skill_draft_files" (
	"draft_id" uuid NOT NULL,
	"path" text NOT NULL,
	"text_content" text,
	"bytes" "bytea",
	"size" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "site_skill_draft_files_draft_id_path_pk" PRIMARY KEY("draft_id","path"),
	CONSTRAINT "site_skill_draft_files_path_size" CHECK (octet_length("site_skill_draft_files"."path") BETWEEN 1 AND 240),
	CONSTRAINT "site_skill_draft_files_one_content" CHECK (("site_skill_draft_files"."text_content" IS NULL) <> ("site_skill_draft_files"."bytes" IS NULL)),
	CONSTRAINT "site_skill_draft_files_size" CHECK ("site_skill_draft_files"."size" = COALESCE(octet_length("site_skill_draft_files"."text_content"), octet_length("site_skill_draft_files"."bytes")) AND "site_skill_draft_files"."size" <= 5242880)
);
--> statement-breakpoint
CREATE TABLE "site_skill_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"base_version_id" uuid NOT NULL,
	"rev" integer DEFAULT 1 NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_skill_drafts_skill_unique" UNIQUE("skill_id"),
	CONSTRAINT "site_skill_drafts_rev_positive" CHECK ("site_skill_drafts"."rev" > 0),
	CONSTRAINT "site_skill_drafts_size" CHECK ("site_skill_drafts"."size_bytes" BETWEEN 0 AND 5242880 AND "site_skill_drafts"."file_count" BETWEEN 0 AND 200)
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind";--> statement-breakpoint
ALTER TABLE "registry_versions" DROP CONSTRAINT "registry_versions_approval";--> statement-breakpoint
ALTER TABLE "registry_versions" DROP CONSTRAINT "registry_versions_publisher_fk";
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "registry_skills" ADD COLUMN "detached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registry_skills" ADD COLUMN "detached_by" uuid;--> statement-breakpoint
ALTER TABLE "registry_skills" ADD COLUMN "detached_from_version" text;--> statement-breakpoint
ALTER TABLE "registry_skills" ADD COLUMN "kobe_shipped_version" text;--> statement-breakpoint
ALTER TABLE "site_skill_draft_files" ADD CONSTRAINT "site_skill_draft_files_draft_id_site_skill_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."site_skill_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_skill_draft_files" ADD CONSTRAINT "site_skill_draft_files_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_skill_drafts" ADD CONSTRAINT "site_skill_drafts_skill_id_registry_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."registry_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_skill_drafts" ADD CONSTRAINT "site_skill_drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_skill_drafts" ADD CONSTRAINT "site_skill_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_skill_drafts" ADD CONSTRAINT "site_skill_drafts_base_fk" FOREIGN KEY ("base_version_id","skill_id") REFERENCES "public"."registry_versions"("id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_skill_draft_files_writer_idx" ON "site_skill_draft_files" USING btree ("updated_by");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_skills" ADD CONSTRAINT "registry_skills_detached_by_users_id_fk" FOREIGN KEY ("detached_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor" CHECK (("notifications"."kind" = 'skill.version.site_published') = ("notifications"."actor_user_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind" CHECK ("notifications"."kind" IN ('schedule.run.succeeded', 'schedule.run.failed', 'schedule.run.interrupted', 'schedule.run.skipped_actions', 'schedule.paused', 'skill.member_add.blocked', 'skill.deprecated', 'skill.version.deprecated', 'skill.version.withdrawn', 'skill.version.revoked', 'skill.version.unrevoked', 'skill.version.site_published'));--> statement-breakpoint
ALTER TABLE "registry_skills" ADD CONSTRAINT "registry_skills_detached" CHECK (("registry_skills"."detached_at" IS NULL AND "registry_skills"."detached_by" IS NULL AND "registry_skills"."detached_from_version" IS NULL AND "registry_skills"."kobe_shipped_version" IS NULL)
        OR ("registry_skills"."detached_at" IS NOT NULL AND "registry_skills"."detached_by" IS NOT NULL
          AND "registry_skills"."detached_from_version" IS NOT NULL AND "registry_skills"."detached_from_version" ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
          AND ("registry_skills"."kobe_shipped_version" IS NULL OR "registry_skills"."kobe_shipped_version" ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$')
          AND "registry_skills"."publisher" = 'kobe'));--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_site_publisher" CHECK ("registry_versions"."publisher"::text <> 'site' OR ("registry_versions"."submitted_by" IS NOT NULL AND "registry_versions"."reviewed_by" IS NULL
        AND "registry_versions"."claimed_by" IS NULL AND NOT "registry_versions"."self_approved" AND "registry_versions"."runtime_storage_key" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_approval" CHECK (("registry_versions"."state" IN ('approved', 'deprecated', 'withdrawn', 'revoked'))
        = ("registry_versions"."approved_at" IS NOT NULL AND ("registry_versions"."reviewed_by" IS NOT NULL OR "registry_versions"."publisher"::text IN ('kobe', 'site'))));