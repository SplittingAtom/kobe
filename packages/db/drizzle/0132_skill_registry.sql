CREATE TYPE "public"."registry_publisher" AS ENUM('kobe', 'maintainer');--> statement-breakpoint
CREATE TYPE "public"."registry_review_action" AS ENUM('submitted', 'claimed', 'unclaimed', 'commented', 'approved', 'changes_requested', 'rejected', 'rejected_and_blocked', 'evals_rerun', 'deprecated', 'withdrawn', 'revoked', 'unrevoked');--> statement-breakpoint
CREATE TYPE "public"."registry_skill_status" AS ENUM('active', 'deprecated', 'unmaintained', 'archived');--> statement-breakpoint
CREATE TYPE "public"."registry_tag_kind" AS ENUM('system', 'topic');--> statement-breakpoint
CREATE TYPE "public"."registry_tag_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."registry_version_state" AS ENUM('submitted', 'in_review', 'changes_requested', 'approved', 'rejected', 'deprecated', 'withdrawn', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."scan_verdict" AS ENUM('pass', 'caution', 'block');--> statement-breakpoint
CREATE TYPE "public"."site_grant" AS ENUM('skill_reviewer');--> statement-breakpoint
CREATE TYPE "public"."skill_install_origin" AS ENUM('team', 'default_tag');--> statement-breakpoint
CREATE TYPE "public"."skill_pin_mode" AS ENUM('pinned', 'within_major', 'latest');--> statement-breakpoint
CREATE TABLE "registry_maintainers" (
	"skill_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_maintainers_skill_id_user_id_pk" PRIMARY KEY("skill_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "registry_review_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" "registry_review_action" NOT NULL,
	"note" text,
	"checklist" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_review_events_note_size" CHECK ("registry_review_events"."note" IS NULL OR char_length("registry_review_events"."note") BETWEEN 1 AND 4000),
	CONSTRAINT "registry_review_events_checklist" CHECK ("registry_review_events"."checklist" IS NULL OR jsonb_typeof("registry_review_events"."checklist") = 'object')
);
--> statement-breakpoint
CREATE TABLE "registry_skill_tags" (
	"skill_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"added_by" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_skill_tags_skill_id_tag_id_pk" PRIMARY KEY("skill_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "registry_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"publisher" "registry_publisher" DEFAULT 'maintainer' NOT NULL,
	"summary" text NOT NULL,
	"status" "registry_skill_status" DEFAULT 'active' NOT NULL,
	"replacement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_skills_name_unique" UNIQUE("name"),
	CONSTRAINT "registry_skills_name_format" CHECK ("registry_skills"."name" ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
	CONSTRAINT "registry_skills_summary_size" CHECK (char_length("registry_skills"."summary") BETWEEN 1 AND 280),
	CONSTRAINT "registry_skills_replacement_not_self" CHECK ("registry_skills"."replacement_id" <> "registry_skills"."id")
);
--> statement-breakpoint
CREATE TABLE "registry_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "registry_tag_kind" NOT NULL,
	"status" "registry_tag_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_tags_name_unique" UNIQUE("name"),
	CONSTRAINT "registry_tags_name_format" CHECK ("registry_tags"."name" ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'),
	CONSTRAINT "registry_tags_system_set" CHECK ("registry_tags"."kind" <> 'system' OR ("registry_tags"."name" IN ('default') AND "registry_tags"."status" = 'active'))
);
--> statement-breakpoint
CREATE TABLE "registry_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"semver" text NOT NULL,
	"seq" integer NOT NULL,
	"runtime_hash" text NOT NULL,
	"package_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"state" "registry_version_state" DEFAULT 'submitted' NOT NULL,
	"source" jsonb NOT NULL,
	"scan" jsonb NOT NULL,
	"verdict" "scan_verdict" NOT NULL,
	"scorecard" jsonb,
	"authoritative_scorecard" jsonb,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"approved_at" timestamp with time zone,
	"mirror" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registry_versions_semver_unique" UNIQUE("skill_id","semver"),
	CONSTRAINT "registry_versions_seq_unique" UNIQUE("skill_id","seq"),
	CONSTRAINT "registry_versions_id_skill_unique" UNIQUE("id","skill_id"),
	CONSTRAINT "registry_versions_semver_format" CHECK ("registry_versions"."semver" ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'),
	CONSTRAINT "registry_versions_seq_positive" CHECK ("registry_versions"."seq" > 0),
	CONSTRAINT "registry_versions_hashes" CHECK ("registry_versions"."runtime_hash" ~ '^[0-9a-f]{64}$' AND "registry_versions"."package_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "registry_versions_documents" CHECK (jsonb_typeof("registry_versions"."manifest") = 'object' AND jsonb_typeof("registry_versions"."provenance") = 'object' AND jsonb_typeof("registry_versions"."source") = 'object' AND jsonb_typeof("registry_versions"."scan") = 'object'
        AND ("registry_versions"."scorecard" IS NULL OR jsonb_typeof("registry_versions"."scorecard") = 'object')
        AND ("registry_versions"."authoritative_scorecard" IS NULL OR jsonb_typeof("registry_versions"."authoritative_scorecard") = 'object')
        AND ("registry_versions"."mirror" IS NULL OR jsonb_typeof("registry_versions"."mirror") = 'object')),
	CONSTRAINT "registry_versions_claim" CHECK (("registry_versions"."claimed_by" IS NULL) = ("registry_versions"."claimed_at" IS NULL)),
	CONSTRAINT "registry_versions_approval" CHECK (("registry_versions"."state" IN ('approved', 'deprecated', 'withdrawn', 'revoked'))
        = ("registry_versions"."approved_at" IS NOT NULL AND "registry_versions"."reviewed_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "site_skill_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"submission_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"registry_team_id" uuid,
	"judge_alias" text,
	"import_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mirror" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scanner" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"eval_limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_skill_settings_singleton" CHECK ("site_skill_settings"."id" = 1),
	CONSTRAINT "site_skill_settings_documents" CHECK (jsonb_typeof("site_skill_settings"."submission_rules") = 'object' AND jsonb_typeof("site_skill_settings"."import_allowlist") = 'array'
        AND jsonb_typeof("site_skill_settings"."mirror") = 'object' AND jsonb_typeof("site_skill_settings"."scanner") = 'object' AND jsonb_typeof("site_skill_settings"."eval_limits") = 'object'),
	CONSTRAINT "site_skill_settings_judge_alias" CHECK ("site_skill_settings"."judge_alias" IS NULL OR char_length("site_skill_settings"."judge_alias") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "site_grants" (
	"user_id" uuid NOT NULL,
	"grant" "site_grant" NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_grants_user_id_grant_pk" PRIMARY KEY("user_id","grant")
);
--> statement-breakpoint
CREATE TABLE "member_skill_enablements" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"skill_ref" jsonb NOT NULL,
	"enabled" boolean NOT NULL,
	"version_id" uuid,
	"pin_mode" "skill_pin_mode",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_skill_enablements_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "member_skill_enablements_ref_unique" UNIQUE("team_id","user_id","skill_ref"),
	CONSTRAINT "member_skill_enablements_ref" CHECK (jsonb_typeof("member_skill_enablements"."skill_ref") = 'object'
        AND "member_skill_enablements"."skill_ref" ->> 'kind' IN ('catalog', 'team')
        AND ("member_skill_enablements"."skill_ref" ->> 'skillId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND "member_skill_enablements"."skill_ref" - 'kind' - 'skillId' = '{}'::jsonb),
	CONSTRAINT "member_skill_enablements_pin" CHECK (("member_skill_enablements"."version_id" IS NULL) = ("member_skill_enablements"."pin_mode" IS NULL)
        AND ("member_skill_enablements"."version_id" IS NULL OR "member_skill_enablements"."skill_ref" ->> 'kind' = 'catalog'))
);
--> statement-breakpoint
CREATE TABLE "team_skill_blocks" (
	"team_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"blocked_by" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_skill_blocks_team_id_skill_id_pk" PRIMARY KEY("team_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "team_skill_installs" (
	"team_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"pin_mode" "skill_pin_mode" NOT NULL,
	"access" "skill_access" NOT NULL,
	"origin" "skill_install_origin" DEFAULT 'team' NOT NULL,
	"installed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_skill_installs_team_id_skill_id_pk" PRIMARY KEY("team_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "team_skill_optouts" (
	"team_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"opted_out_by" uuid NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_skill_optouts_team_id_skill_id_pk" PRIMARY KEY("team_id","skill_id"),
	CONSTRAINT "team_skill_optouts_reason_size" CHECK ("team_skill_optouts"."reason" IS NULL OR char_length("team_skill_optouts"."reason") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "registry_maintainers" ADD CONSTRAINT "registry_maintainers_skill_id_registry_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."registry_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_maintainers" ADD CONSTRAINT "registry_maintainers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_maintainers" ADD CONSTRAINT "registry_maintainers_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_review_events" ADD CONSTRAINT "registry_review_events_version_id_registry_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."registry_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_review_events" ADD CONSTRAINT "registry_review_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_skill_tags" ADD CONSTRAINT "registry_skill_tags_skill_id_registry_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."registry_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_skill_tags" ADD CONSTRAINT "registry_skill_tags_tag_id_registry_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."registry_tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_skill_tags" ADD CONSTRAINT "registry_skill_tags_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_skills" ADD CONSTRAINT "registry_skills_replacement_fk" FOREIGN KEY ("replacement_id") REFERENCES "public"."registry_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_skill_id_registry_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."registry_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_skill_settings" ADD CONSTRAINT "site_skill_settings_registry_team_id_teams_id_fk" FOREIGN KEY ("registry_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_skill_settings" ADD CONSTRAINT "site_skill_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_grants" ADD CONSTRAINT "site_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_grants" ADD CONSTRAINT "site_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_skill_enablements" ADD CONSTRAINT "member_skill_enablements_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_skill_enablements" ADD CONSTRAINT "member_skill_enablements_version_id_registry_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."registry_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_skill_enablements" ADD CONSTRAINT "member_skill_enablements_member_fk" FOREIGN KEY ("team_id","user_id") REFERENCES "public"."team_members"("team_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_blocks" ADD CONSTRAINT "team_skill_blocks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_blocks" ADD CONSTRAINT "team_skill_blocks_skill_id_registry_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."registry_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_blocks" ADD CONSTRAINT "team_skill_blocks_blocked_by_users_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_installs" ADD CONSTRAINT "team_skill_installs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_installs" ADD CONSTRAINT "team_skill_installs_skill_id_registry_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."registry_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_installs" ADD CONSTRAINT "team_skill_installs_installed_by_users_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_installs" ADD CONSTRAINT "team_skill_installs_version_fk" FOREIGN KEY ("version_id","skill_id") REFERENCES "public"."registry_versions"("id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_optouts" ADD CONSTRAINT "team_skill_optouts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_optouts" ADD CONSTRAINT "team_skill_optouts_skill_id_registry_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."registry_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_optouts" ADD CONSTRAINT "team_skill_optouts_opted_out_by_users_id_fk" FOREIGN KEY ("opted_out_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "registry_maintainers_user_idx" ON "registry_maintainers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "registry_review_events_version_idx" ON "registry_review_events" USING btree ("version_id","at");--> statement-breakpoint
CREATE INDEX "registry_skill_tags_tag_idx" ON "registry_skill_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "registry_versions_state_idx" ON "registry_versions" USING btree ("state","submitted_at");--> statement-breakpoint
CREATE INDEX "registry_versions_runtime_idx" ON "registry_versions" USING btree ("runtime_hash");--> statement-breakpoint
CREATE INDEX "team_skill_installs_skill_idx" ON "team_skill_installs" USING btree ("skill_id");