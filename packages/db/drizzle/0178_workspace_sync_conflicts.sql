CREATE TABLE "workspace_sync_conflicts" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid,
	"run_id" uuid,
	"path" text NOT NULL,
	"conflict_path" text NOT NULL,
	"member_sha256" text NOT NULL,
	"agent_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_notified_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "workspace_sync_conflicts_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "workspace_sync_conflicts_paths" CHECK (octet_length("workspace_sync_conflicts"."path") BETWEEN 1 AND 1024 AND octet_length("workspace_sync_conflicts"."conflict_path") BETWEEN 1 AND 1024),
	CONSTRAINT "workspace_sync_conflicts_hashes" CHECK ("workspace_sync_conflicts"."member_sha256" ~ '^[0-9a-f]{64}$' AND "workspace_sync_conflicts"."agent_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_sync_conflicts_run_thread" CHECK ("workspace_sync_conflicts"."run_id" IS NULL OR "workspace_sync_conflicts"."thread_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "workspace_sync_conflicts" ADD CONSTRAINT "workspace_sync_conflicts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_sync_conflicts" ADD CONSTRAINT "workspace_sync_conflicts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_sync_conflicts" ADD CONSTRAINT "workspace_sync_conflicts_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_sync_conflicts_open_idx" ON "workspace_sync_conflicts" USING btree ("team_id","user_id","thread_id","created_at") WHERE "workspace_sync_conflicts"."resolved_at" IS NULL AND "workspace_sync_conflicts"."dismissed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "workspace_sync_conflicts_member_idx" ON "workspace_sync_conflicts" USING btree ("team_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_sync_conflicts_run_idx" ON "workspace_sync_conflicts" USING btree ("team_id","run_id") WHERE "workspace_sync_conflicts"."run_id" IS NOT NULL;