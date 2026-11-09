CREATE TABLE "project_checkouts" (
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"base_commit_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_checkouts_team_id_project_id_user_id_pk" PRIMARY KEY("team_id","project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "project_commits" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"parent_id" uuid,
	"author_user_id" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"thread_id" uuid,
	"run_id" uuid,
	"message" text NOT NULL,
	"file_count" integer NOT NULL,
	"bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_commits_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "project_commits_project_commit_unique" UNIQUE("team_id","project_id","id"),
	CONSTRAINT "project_commits_seq" CHECK ("project_commits"."seq" >= 1),
	CONSTRAINT "project_commits_parent" CHECK ("project_commits"."parent_id" IS DISTINCT FROM "project_commits"."id"),
	CONSTRAINT "project_commits_author_kind" CHECK ("project_commits"."author_kind" IN ('user', 'agent')),
	CONSTRAINT "project_commits_message" CHECK (char_length(btrim("project_commits"."message")) BETWEEN 1 AND 500),
	CONSTRAINT "project_commits_counts" CHECK ("project_commits"."file_count" BETWEEN 0 AND 500 AND "project_commits"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_tree_entries" (
	"team_id" uuid NOT NULL,
	"commit_id" uuid NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"blob_ref" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	CONSTRAINT "project_tree_entries_team_id_commit_id_path_pk" PRIMARY KEY("team_id","commit_id","path"),
	CONSTRAINT "project_tree_entries_path" CHECK (char_length("project_tree_entries"."path") BETWEEN 1 AND 1024 AND "project_tree_entries"."path" !~ '(^/|//|/$|\\)' AND "project_tree_entries"."path" !~ '(^|/)\.\.?(/|$)'),
	CONSTRAINT "project_tree_entries_size" CHECK ("project_tree_entries"."size_bytes" BETWEEN 0 AND 52428800),
	CONSTRAINT "project_tree_entries_sha256" CHECK ("project_tree_entries"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "team_storage_quotas" ADD COLUMN "max_objects" bigint;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "visibility" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "head_commit_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "live_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "live_objects" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "history_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "history_objects" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_checkouts" ADD CONSTRAINT "project_checkouts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_checkouts" ADD CONSTRAINT "project_checkouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_checkouts" ADD CONSTRAINT "project_checkouts_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_checkouts" ADD CONSTRAINT "project_checkouts_base_fk" FOREIGN KEY ("team_id","project_id","base_commit_id") REFERENCES "public"."project_commits"("team_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_commits" ADD CONSTRAINT "project_commits_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_commits" ADD CONSTRAINT "project_commits_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_commits" ADD CONSTRAINT "project_commits_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tree_entries" ADD CONSTRAINT "project_tree_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tree_entries" ADD CONSTRAINT "project_tree_entries_commit_fk" FOREIGN KEY ("team_id","commit_id") REFERENCES "public"."project_commits"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_checkouts_user_idx" ON "project_checkouts" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE INDEX "project_checkouts_base_idx" ON "project_checkouts" USING btree ("team_id","base_commit_id") WHERE "project_checkouts"."base_commit_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_commits_seq_unique" ON "project_commits" USING btree ("team_id","project_id","seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_commits_thread_idx" ON "project_commits" USING btree ("team_id","thread_id") WHERE "project_commits"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "project_commits_run_idx" ON "project_commits" USING btree ("team_id","run_id") WHERE "project_commits"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "project_commits_parent_idx" ON "project_commits" USING btree ("team_id","parent_id") WHERE "project_commits"."parent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "project_tree_entries_blob_ref_idx" ON "project_tree_entries" USING btree ("team_id","blob_ref");--> statement-breakpoint
ALTER TABLE "team_storage_quotas" ADD CONSTRAINT "team_storage_quotas_max_objects" CHECK ("team_storage_quotas"."max_objects" IS NULL OR "team_storage_quotas"."max_objects" >= 0);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_visibility" CHECK ("projects"."visibility" IN ('workspace', 'restricted'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_storage_counts" CHECK ("projects"."live_bytes" >= 0 AND "projects"."live_objects" >= 0 AND "projects"."history_bytes" >= 0 AND "projects"."history_objects" >= 0);