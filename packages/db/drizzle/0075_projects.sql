CREATE TABLE "project_files" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"path" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"blob_ref" text NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"added_by" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_files_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "project_files_path" CHECK (char_length("project_files"."path") BETWEEN 1 AND 1024 AND "project_files"."path" !~ '(^/|//|/$|\\)' AND "project_files"."path" !~ '(^|/)\.\.?(/|$)'),
	CONSTRAINT "project_files_size" CHECK ("project_files"."size_bytes" BETWEEN 0 AND 52428800),
	CONSTRAINT "project_files_sha256" CHECK ("project_files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_files_source" CHECK ("project_files"."source" IN ('upload', 'proposal'))
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"added_by" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_team_id_project_id_user_id_pk" PRIMARY KEY("team_id","project_id","user_id"),
	CONSTRAINT "project_members_role" CHECK ("project_members"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"default_agent_id" uuid,
	"members_mode" text DEFAULT 'team' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "projects_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "projects_slug" CHECK (char_length("projects"."slug") <= 40 AND "projects"."slug" ~ '^[a-z0-9][a-z0-9-]*$'),
	CONSTRAINT "projects_name" CHECK (char_length(btrim("projects"."name")) BETWEEN 1 AND 100),
	CONSTRAINT "projects_description" CHECK (char_length("projects"."description") <= 500),
	CONSTRAINT "projects_instructions" CHECK (octet_length("projects"."instructions") <= 8192),
	CONSTRAINT "projects_members_mode" CHECK ("projects"."members_mode" IN ('team', 'selected'))
);
--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_files_path_unique" ON "project_files" USING btree ("team_id","project_id","path");--> statement-breakpoint
CREATE INDEX "project_files_blob_ref_idx" ON "project_files" USING btree ("team_id","blob_ref");--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "project_members" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_unique" ON "projects" USING btree ("team_id","slug");--> statement-breakpoint
CREATE INDEX "projects_team_active_idx" ON "projects" USING btree ("team_id","name") WHERE "projects"."archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_docs" ADD CONSTRAINT "memory_docs_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE restrict ON UPDATE no action;