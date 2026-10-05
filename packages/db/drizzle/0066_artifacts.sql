CREATE TABLE "artifact_versions" (
	"team_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"thread_id" uuid NOT NULL,
	"blob_ref" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_versions_team_id_artifact_id_version_pk" PRIMARY KEY("team_id","artifact_id","version"),
	CONSTRAINT "artifact_versions_artifact_version" UNIQUE("artifact_id","version"),
	CONSTRAINT "artifact_versions_tool_call" UNIQUE("team_id","tool_call_id"),
	CONSTRAINT "artifact_versions_version" CHECK ("artifact_versions"."version" >= 1),
	CONSTRAINT "artifact_versions_size" CHECK ("artifact_versions"."size_bytes" >= 0),
	CONSTRAINT "artifact_versions_sha256" CHECK ("artifact_versions"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"language" text,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "artifacts_kind" CHECK ("artifacts"."kind" IN ('html', 'svg', 'markdown', 'mermaid', 'code', 'csv')),
	CONSTRAINT "artifacts_title_length" CHECK (char_length("artifacts"."title") BETWEEN 1 AND 200),
	CONSTRAINT "artifacts_language" CHECK ("artifacts"."language" IS NULL OR ("artifacts"."kind" = 'code' AND "artifacts"."language" ~ '^[a-z0-9][a-z0-9+#.-]{0,31}$')),
	CONSTRAINT "artifacts_current_version" CHECK ("artifacts"."current_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_fk" FOREIGN KEY ("team_id","artifact_id") REFERENCES "public"."artifacts"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_versions_blob_ref_idx" ON "artifact_versions" USING btree ("team_id","blob_ref");--> statement-breakpoint
CREATE INDEX "artifact_versions_thread_idx" ON "artifact_versions" USING btree ("team_id","thread_id");--> statement-breakpoint
CREATE INDEX "artifacts_thread_idx" ON "artifacts" USING btree ("team_id","thread_id","created_at");