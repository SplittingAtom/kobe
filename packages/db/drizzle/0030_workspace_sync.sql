CREATE TYPE "public"."workspace_file_origin" AS ENUM('sandbox', 'server');--> statement-breakpoint
CREATE TABLE "workspace_blobs" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"deleting" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "workspace_blobs_team_id_user_id_sha256_pk" PRIMARY KEY("team_id","user_id","sha256"),
	CONSTRAINT "workspace_blobs_sha" CHECK ("workspace_blobs"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_blobs_size" CHECK ("workspace_blobs"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_files" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"path" text NOT NULL,
	"rev" bigint NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"sha256" text,
	"blob_key" text,
	"size" bigint NOT NULL,
	"mtime_ms" bigint NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	"origin" "workspace_file_origin" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_files_team_id_user_id_path_pk" PRIMARY KEY("team_id","user_id","path"),
	CONSTRAINT "workspace_files_path" CHECK (octet_length("workspace_files"."path") BETWEEN 1 AND 1024 AND "workspace_files"."path" !~ '(^/|^\.\./|/\.\./|/\.\.$|^\.\.$|//)'),
	CONSTRAINT "workspace_files_content" CHECK (("workspace_files"."deleted" AND "workspace_files"."sha256" IS NULL AND "workspace_files"."blob_key" IS NULL) OR (NOT "workspace_files"."deleted" AND "workspace_files"."sha256" ~ '^[0-9a-f]{64}$' AND char_length("workspace_files"."blob_key") BETWEEN 1 AND 1024)),
	CONSTRAINT "workspace_files_numbers" CHECK ("workspace_files"."rev" > 0 AND "workspace_files"."size" >= 0 AND "workspace_files"."mtime_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_sync" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"head_rev" bigint DEFAULT 0 NOT NULL,
	"horizon_rev" bigint DEFAULT 0 NOT NULL,
	"live_files" integer DEFAULT 0 NOT NULL,
	"live_bytes" bigint DEFAULT 0 NOT NULL,
	"tombstones" integer DEFAULT 0 NOT NULL,
	"blob_count" integer DEFAULT 0 NOT NULL,
	"blob_bytes" bigint DEFAULT 0 NOT NULL,
	"pending_blobs" integer DEFAULT 0 NOT NULL,
	"pending_bytes" bigint DEFAULT 0 NOT NULL,
	"pending_since" timestamp with time zone,
	"last_push_at" timestamp with time zone,
	"last_restore_at" timestamp with time zone,
	"last_restore_ms" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_sync_team_id_user_id_pk" PRIMARY KEY("team_id","user_id"),
	CONSTRAINT "workspace_sync_counts" CHECK ("workspace_sync"."live_files" >= 0 AND "workspace_sync"."live_bytes" >= 0 AND "workspace_sync"."tombstones" >= 0 AND "workspace_sync"."blob_count" >= 0 AND "workspace_sync"."blob_bytes" >= 0 AND "workspace_sync"."pending_blobs" >= 0 AND "workspace_sync"."pending_bytes" >= 0),
	CONSTRAINT "workspace_sync_horizon" CHECK ("workspace_sync"."horizon_rev" BETWEEN 0 AND "workspace_sync"."head_rev")
);
--> statement-breakpoint
ALTER TABLE "workspace_blobs" ADD CONSTRAINT "workspace_blobs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_blobs" ADD CONSTRAINT "workspace_blobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_files" ADD CONSTRAINT "workspace_files_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_files" ADD CONSTRAINT "workspace_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_sync" ADD CONSTRAINT "workspace_sync_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_sync" ADD CONSTRAINT "workspace_sync_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_files_rev_idx" ON "workspace_files" USING btree ("team_id","user_id","rev");--> statement-breakpoint
CREATE INDEX "workspace_files_sha_idx" ON "workspace_files" USING btree ("team_id","user_id","sha256") WHERE NOT "workspace_files"."deleted";