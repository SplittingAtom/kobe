CREATE TABLE "files" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"blob_ref" text NOT NULL,
	"scan_status" text DEFAULT 'none' NOT NULL,
	"run_id" uuid,
	"tool_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "files_kind" CHECK ("files"."kind" IN ('upload', 'shared')),
	CONSTRAINT "files_scan_status" CHECK ("files"."scan_status" IN ('none', 'clean', 'rejected')),
	CONSTRAINT "files_name_length" CHECK (char_length("files"."name") BETWEEN 1 AND 255),
	CONSTRAINT "files_size" CHECK ("files"."size_bytes" >= 0),
	CONSTRAINT "files_sha256" CHECK ("files"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "team_storage_quotas" (
	"team_id" uuid NOT NULL,
	"max_bytes" bigint,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_storage_quotas_team_id_pk" PRIMARY KEY("team_id"),
	CONSTRAINT "team_storage_quotas_max" CHECK ("team_storage_quotas"."max_bytes" IS NULL OR "team_storage_quotas"."max_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_storage_quotas" ADD CONSTRAINT "team_storage_quotas_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_storage_quotas" ADD CONSTRAINT "team_storage_quotas_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "files_tool_call_unique" ON "files" USING btree ("team_id","tool_call_id") WHERE "files"."tool_call_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "files_blob_ref_idx" ON "files" USING btree ("team_id","blob_ref");--> statement-breakpoint
CREATE INDEX "files_thread_idx" ON "files" USING btree ("team_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "files_user_idx" ON "files" USING btree ("team_id","user_id");