CREATE TABLE "workspace_file_hold_history" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"path" text NOT NULL,
	"moved_to" text NOT NULL,
	"sha256" text NOT NULL,
	"blob_key" text NOT NULL,
	"size" bigint NOT NULL,
	"mtime_ms" bigint NOT NULL,
	"file_rev" bigint NOT NULL,
	"kept_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_file_hold_history_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "workspace_file_hold_history_paths" CHECK (octet_length("workspace_file_hold_history"."path") BETWEEN 1 AND 1024 AND octet_length("workspace_file_hold_history"."moved_to") BETWEEN 1 AND 1024),
	CONSTRAINT "workspace_file_hold_history_content" CHECK ("workspace_file_hold_history"."sha256" ~ '^[0-9a-f]{64}$' AND char_length("workspace_file_hold_history"."blob_key") BETWEEN 1 AND 1024),
	CONSTRAINT "workspace_file_hold_history_numbers" CHECK ("workspace_file_hold_history"."size" >= 0 AND "workspace_file_hold_history"."mtime_ms" >= 0 AND "workspace_file_hold_history"."file_rev" > 0)
);
--> statement-breakpoint
ALTER TABLE "workspace_file_hold_history" ADD CONSTRAINT "workspace_file_hold_history_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_file_hold_history" ADD CONSTRAINT "workspace_file_hold_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_file_hold_history_user_idx" ON "workspace_file_hold_history" USING btree ("team_id","user_id");