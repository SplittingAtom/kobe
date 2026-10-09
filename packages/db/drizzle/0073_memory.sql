CREATE TABLE "memory_doc_versions" (
	"team_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"blob_ref" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"run_id" uuid,
	"tool_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_doc_versions_team_id_doc_id_version_pk" PRIMARY KEY("team_id","doc_id","version"),
	CONSTRAINT "memory_doc_versions_version" CHECK ("memory_doc_versions"."version" >= 1),
	CONSTRAINT "memory_doc_versions_size" CHECK ("memory_doc_versions"."size_bytes" BETWEEN 0 AND 65536),
	CONSTRAINT "memory_doc_versions_sha256" CHECK ("memory_doc_versions"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "memory_doc_versions_actor" CHECK ("memory_doc_versions"."actor_kind" IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "memory_docs" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" uuid,
	"project_id" uuid,
	"path" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_docs_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "memory_docs_scope" CHECK ("memory_docs"."scope" IN ('user', 'project')),
	CONSTRAINT "memory_docs_scope_keys" CHECK (("memory_docs"."scope" = 'user' AND "memory_docs"."owner_user_id" IS NOT NULL AND "memory_docs"."project_id" IS NULL) OR ("memory_docs"."scope" = 'project' AND "memory_docs"."owner_user_id" IS NULL AND "memory_docs"."project_id" IS NOT NULL)),
	CONSTRAINT "memory_docs_path" CHECK (char_length("memory_docs"."path") <= 200 AND "memory_docs"."path" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}\.md$' AND position('..' in "memory_docs"."path") = 0),
	CONSTRAINT "memory_docs_version" CHECK ("memory_docs"."current_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "team_memory_settings" (
	"team_id" uuid NOT NULL,
	"memory_enabled" boolean DEFAULT true NOT NULL,
	"project_memory_enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_settings_team_id_pk" PRIMARY KEY("team_id")
);
--> statement-breakpoint
ALTER TABLE "memory_doc_versions" ADD CONSTRAINT "memory_doc_versions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_doc_versions" ADD CONSTRAINT "memory_doc_versions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_doc_versions" ADD CONSTRAINT "memory_doc_versions_doc_fk" FOREIGN KEY ("team_id","doc_id") REFERENCES "public"."memory_docs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_docs" ADD CONSTRAINT "memory_docs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_docs" ADD CONSTRAINT "memory_docs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_settings" ADD CONSTRAINT "team_memory_settings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_settings" ADD CONSTRAINT "team_memory_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_doc_versions_blob_ref_idx" ON "memory_doc_versions" USING btree ("team_id","blob_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_docs_user_path_unique" ON "memory_docs" USING btree ("team_id","owner_user_id","path") WHERE "memory_docs"."scope" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_docs_project_path_unique" ON "memory_docs" USING btree ("team_id","project_id","path") WHERE "memory_docs"."scope" = 'project';