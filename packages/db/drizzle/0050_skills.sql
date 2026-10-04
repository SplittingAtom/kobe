CREATE TYPE "public"."skill_source" AS ENUM('zip', 'skill_md');--> statement-breakpoint
CREATE TABLE "install_skill_versions" (
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"source" "skill_source" NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"file_count" integer NOT NULL,
	"uncompressed_bytes" integer NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "install_skill_versions_skill_id_version_pk" PRIMARY KEY("skill_id","version"),
	CONSTRAINT "install_skill_versions_version_positive" CHECK ("install_skill_versions"."version" > 0),
	CONSTRAINT "install_skill_versions_frontmatter_object" CHECK (jsonb_typeof("install_skill_versions"."frontmatter") = 'object' AND octet_length("install_skill_versions"."frontmatter"::text) <= 32768),
	CONSTRAINT "install_skill_versions_content_hash_format" CHECK ("install_skill_versions"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "install_skill_versions_sizes" CHECK ("install_skill_versions"."size_bytes" > 0 AND "install_skill_versions"."size_bytes" <= 67108864 AND "install_skill_versions"."file_count" > 0 AND "install_skill_versions"."uncompressed_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "install_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"description" text NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "install_skills_slug_unique" UNIQUE("owner_user_id","slug"),
	CONSTRAINT "install_skills_slug_format" CHECK ("install_skills"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
	CONSTRAINT "install_skills_description_size" CHECK (char_length("install_skills"."description") BETWEEN 1 AND 1024),
	CONSTRAINT "install_skills_latest_version_positive" CHECK ("install_skills"."latest_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "team_skill_versions" (
	"team_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"source" "skill_source" NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"file_count" integer NOT NULL,
	"uncompressed_bytes" integer NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_skill_versions_team_id_skill_id_version_pk" PRIMARY KEY("team_id","skill_id","version"),
	CONSTRAINT "team_skill_versions_version_positive" CHECK ("team_skill_versions"."version" > 0),
	CONSTRAINT "team_skill_versions_frontmatter_object" CHECK (jsonb_typeof("team_skill_versions"."frontmatter") = 'object' AND octet_length("team_skill_versions"."frontmatter"::text) <= 32768),
	CONSTRAINT "team_skill_versions_content_hash_format" CHECK ("team_skill_versions"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "team_skill_versions_sizes" CHECK ("team_skill_versions"."size_bytes" > 0 AND "team_skill_versions"."size_bytes" <= 67108864 AND "team_skill_versions"."file_count" > 0 AND "team_skill_versions"."uncompressed_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "team_skills" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"description" text NOT NULL,
	"latest_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_skills_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "team_skills_slug_unique" UNIQUE("team_id","slug"),
	CONSTRAINT "team_skills_slug_format" CHECK ("team_skills"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
	CONSTRAINT "team_skills_description_size" CHECK (char_length("team_skills"."description") BETWEEN 1 AND 1024),
	CONSTRAINT "team_skills_latest_version_positive" CHECK ("team_skills"."latest_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "install_skill_versions" ADD CONSTRAINT "install_skill_versions_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "install_skill_versions" ADD CONSTRAINT "install_skill_versions_skill_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."install_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "install_skills" ADD CONSTRAINT "install_skills_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD CONSTRAINT "team_skill_versions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD CONSTRAINT "team_skill_versions_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD CONSTRAINT "team_skill_versions_skill_fk" FOREIGN KEY ("team_id","skill_id") REFERENCES "public"."team_skills"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skills" ADD CONSTRAINT "team_skills_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skills" ADD CONSTRAINT "team_skills_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;