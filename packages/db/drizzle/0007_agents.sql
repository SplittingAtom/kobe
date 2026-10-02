CREATE TYPE "public"."agent_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."install_agent_scope" AS ENUM('personal', 'gallery');--> statement-breakpoint
CREATE TABLE "install_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "install_agent_scope" NOT NULL,
	"owner_user_id" uuid,
	"slug" text NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"current_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "install_agents_owner_by_scope" CHECK (("install_agents"."scope" = 'personal') = ("install_agents"."owner_user_id" IS NOT NULL)),
	CONSTRAINT "install_agents_slug_format" CHECK ("install_agents"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$'),
	CONSTRAINT "install_agents_prompt_size" CHECK (octet_length("install_agents"."prompt") <= 102400),
	CONSTRAINT "install_agents_frontmatter_object" CHECK (jsonb_typeof("install_agents"."frontmatter") = 'object' AND octet_length("install_agents"."frontmatter"::text) <= 32768),
	CONSTRAINT "install_agents_revision_positive" CHECK ("install_agents"."revision" > 0),
	CONSTRAINT "install_agents_current_version_positive" CHECK ("install_agents"."current_version" IS NULL OR "install_agents"."current_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "team_agents" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"current_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_agents_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "team_agents_slug_unique" UNIQUE("team_id","slug"),
	CONSTRAINT "team_agents_slug_format" CHECK ("team_agents"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$'),
	CONSTRAINT "team_agents_prompt_size" CHECK (octet_length("team_agents"."prompt") <= 102400),
	CONSTRAINT "team_agents_frontmatter_object" CHECK (jsonb_typeof("team_agents"."frontmatter") = 'object' AND octet_length("team_agents"."frontmatter"::text) <= 32768),
	CONSTRAINT "team_agents_revision_positive" CHECK ("team_agents"."revision" > 0),
	CONSTRAINT "team_agents_current_version_positive" CHECK ("team_agents"."current_version" IS NULL OR "team_agents"."current_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "install_agents" ADD CONSTRAINT "install_agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agents" ADD CONSTRAINT "team_agents_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agents" ADD CONSTRAINT "team_agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "install_agents_personal_slug_unique" ON "install_agents" USING btree ("owner_user_id","slug") WHERE "install_agents"."scope" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "install_agents_gallery_slug_unique" ON "install_agents" USING btree ("slug") WHERE "install_agents"."scope" = 'gallery';