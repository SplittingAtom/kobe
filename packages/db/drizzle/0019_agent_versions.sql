CREATE TYPE "public"."agent_scope" AS ENUM('team', 'personal', 'gallery');--> statement-breakpoint
CREATE TABLE "install_agent_versions" (
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"prompt" text NOT NULL,
	"tool_manifest" jsonb NOT NULL,
	"published_by" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"draft_revision" integer,
	"republished_from" integer,
	CONSTRAINT "install_agent_versions_agent_id_version_pk" PRIMARY KEY("agent_id","version"),
	CONSTRAINT "install_agent_versions_version_positive" CHECK ("install_agent_versions"."version" > 0),
	CONSTRAINT "install_agent_versions_prompt_size" CHECK (octet_length("install_agent_versions"."prompt") <= 102400),
	CONSTRAINT "install_agent_versions_frontmatter_object" CHECK (jsonb_typeof("install_agent_versions"."frontmatter") = 'object' AND octet_length("install_agent_versions"."frontmatter"::text) <= 32768),
	CONSTRAINT "install_agent_versions_tool_manifest_object" CHECK (jsonb_typeof("install_agent_versions"."tool_manifest") = 'object' AND octet_length("install_agent_versions"."tool_manifest"::text) <= 65536),
	CONSTRAINT "install_agent_versions_origin" CHECK (("install_agent_versions"."draft_revision" IS NULL) <> ("install_agent_versions"."republished_from" IS NULL) AND ("install_agent_versions"."draft_revision" IS NULL OR "install_agent_versions"."draft_revision" > 0) AND ("install_agent_versions"."republished_from" IS NULL OR ("install_agent_versions"."republished_from" > 0 AND "install_agent_versions"."republished_from" < "install_agent_versions"."version")))
);
--> statement-breakpoint
CREATE TABLE "team_agent_versions" (
	"team_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"prompt" text NOT NULL,
	"tool_manifest" jsonb NOT NULL,
	"published_by" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"draft_revision" integer,
	"republished_from" integer,
	CONSTRAINT "team_agent_versions_team_id_agent_id_version_pk" PRIMARY KEY("team_id","agent_id","version"),
	CONSTRAINT "team_agent_versions_version_positive" CHECK ("team_agent_versions"."version" > 0),
	CONSTRAINT "team_agent_versions_prompt_size" CHECK (octet_length("team_agent_versions"."prompt") <= 102400),
	CONSTRAINT "team_agent_versions_frontmatter_object" CHECK (jsonb_typeof("team_agent_versions"."frontmatter") = 'object' AND octet_length("team_agent_versions"."frontmatter"::text) <= 32768),
	CONSTRAINT "team_agent_versions_tool_manifest_object" CHECK (jsonb_typeof("team_agent_versions"."tool_manifest") = 'object' AND octet_length("team_agent_versions"."tool_manifest"::text) <= 65536),
	CONSTRAINT "team_agent_versions_origin" CHECK (("team_agent_versions"."draft_revision" IS NULL) <> ("team_agent_versions"."republished_from" IS NULL) AND ("team_agent_versions"."draft_revision" IS NULL OR "team_agent_versions"."draft_revision" > 0) AND ("team_agent_versions"."republished_from" IS NULL OR ("team_agent_versions"."republished_from" > 0 AND "team_agent_versions"."republished_from" < "team_agent_versions"."version")))
);
--> statement-breakpoint
ALTER TABLE "threads" DROP CONSTRAINT "threads_agent_pin";--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "agent_scope" "agent_scope";--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "team_agent_id" uuid GENERATED ALWAYS AS (CASE WHEN agent_scope = 'team' THEN agent_id END) STORED;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "install_agent_id" uuid GENERATED ALWAYS AS (CASE WHEN agent_scope IN ('personal', 'gallery') THEN agent_id END) STORED;--> statement-breakpoint
ALTER TABLE "install_agents" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_agents" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "install_agent_versions" ADD CONSTRAINT "install_agent_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "install_agent_versions" ADD CONSTRAINT "install_agent_versions_agent_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."install_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agent_versions" ADD CONSTRAINT "team_agent_versions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agent_versions" ADD CONSTRAINT "team_agent_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agent_versions" ADD CONSTRAINT "team_agent_versions_agent_fk" FOREIGN KEY ("team_id","agent_id") REFERENCES "public"."team_agents"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_team_agent_version_fk" FOREIGN KEY ("team_id","team_agent_id","agent_version") REFERENCES "public"."team_agent_versions"("team_id","agent_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_install_agent_version_fk" FOREIGN KEY ("install_agent_id","agent_version") REFERENCES "public"."install_agent_versions"("agent_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "install_agents" ADD CONSTRAINT "install_agents_current_version_fk" FOREIGN KEY ("id","current_version") REFERENCES "public"."install_agent_versions"("agent_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agents" ADD CONSTRAINT "team_agents_current_version_fk" FOREIGN KEY ("team_id","id","current_version") REFERENCES "public"."team_agent_versions"("team_id","agent_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "threads_team_agent_idx" ON "threads" USING btree ("team_id","team_agent_id","agent_version") WHERE "threads"."team_agent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "threads_install_agent_idx" ON "threads" USING btree ("team_id","install_agent_id","agent_version") WHERE "threads"."install_agent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_agent_pin" CHECK (("threads"."agent_id" IS NULL) = ("threads"."agent_version" IS NULL) AND ("threads"."agent_id" IS NULL) = ("threads"."agent_scope" IS NULL) AND ("threads"."agent_version" IS NULL OR "threads"."agent_version" > 0));