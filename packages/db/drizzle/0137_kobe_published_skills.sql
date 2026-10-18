ALTER TABLE "registry_versions" DROP CONSTRAINT "registry_versions_approval";--> statement-breakpoint
ALTER TABLE "registry_skill_tags" ALTER COLUMN "added_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_versions" ALTER COLUMN "submitted_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "team_skill_installs" ALTER COLUMN "installed_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_default_syncs" ALTER COLUMN "requested_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_skill_tags" ADD COLUMN "by_kobe" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_versions" ADD COLUMN "publisher" "registry_publisher" DEFAULT 'maintainer' NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_versions" ADD COLUMN "runtime_storage_key" text;--> statement-breakpoint
ALTER TABLE "registry_versions" ADD COLUMN "runtime_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "registry_versions" ADD COLUMN "package_storage_key" text;--> statement-breakpoint
ALTER TABLE "team_skill_installs" ADD COLUMN "by_kobe" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_default_syncs" ADD COLUMN "by_kobe" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_skills" ADD CONSTRAINT "registry_skills_id_publisher_unique" UNIQUE("id","publisher");--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_publisher_fk" FOREIGN KEY ("skill_id","publisher") REFERENCES "public"."registry_skills"("id","publisher") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_skill_tags" ADD CONSTRAINT "registry_skill_tags_by_kobe" CHECK ("registry_skill_tags"."by_kobe" = ("registry_skill_tags"."added_by" IS NULL));--> statement-breakpoint
ALTER TABLE "registry_skills" ADD CONSTRAINT "registry_skills_kobe_names" CHECK (("registry_skills"."publisher" = 'kobe') = ("registry_skills"."name" IN ('data-analysis', 'charts', 'docx', 'pdf', 'xlsx', 'code-review', 'skill-creator')));--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_kobe_publisher" CHECK (("registry_versions"."publisher" = 'kobe') = ("registry_versions"."submitted_by" IS NULL)
        AND ("registry_versions"."publisher" <> 'kobe' OR ("registry_versions"."reviewed_by" IS NULL AND "registry_versions"."claimed_by" IS NULL
          AND NOT "registry_versions"."self_approved" AND "registry_versions"."runtime_storage_key" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_storage" CHECK (("registry_versions"."runtime_storage_key" IS NULL) = ("registry_versions"."runtime_size_bytes" IS NULL)
        AND ("registry_versions"."runtime_size_bytes" IS NULL OR "registry_versions"."runtime_size_bytes" > 0)
        AND ("registry_versions"."package_storage_key" IS NULL OR "registry_versions"."runtime_storage_key" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_approval" CHECK (("registry_versions"."state" IN ('approved', 'deprecated', 'withdrawn', 'revoked'))
        = ("registry_versions"."approved_at" IS NOT NULL AND ("registry_versions"."reviewed_by" IS NOT NULL OR "registry_versions"."publisher" = 'kobe')));--> statement-breakpoint
ALTER TABLE "team_skill_installs" ADD CONSTRAINT "team_skill_installs_by_kobe" CHECK ("team_skill_installs"."by_kobe" = ("team_skill_installs"."installed_by" IS NULL));--> statement-breakpoint
ALTER TABLE "skill_default_syncs" ADD CONSTRAINT "skill_default_syncs_by_kobe" CHECK ("skill_default_syncs"."by_kobe" = ("skill_default_syncs"."requested_by" IS NULL));