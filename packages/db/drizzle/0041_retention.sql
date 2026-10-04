CREATE TABLE "retention_blob_deletions" (
	"team_id" uuid NOT NULL,
	"key" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "retention_blob_deletions_team_id_key_pk" PRIMARY KEY("team_id","key"),
	CONSTRAINT "retention_blob_deletions_key" CHECK (char_length("retention_blob_deletions"."key") BETWEEN 1 AND 1024),
	CONSTRAINT "retention_blob_deletions_attempts" CHECK ("retention_blob_deletions"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "team_retention" (
	"team_id" uuid NOT NULL,
	"period" text NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_retention_team_id_pk" PRIMARY KEY("team_id"),
	CONSTRAINT "team_retention_period" CHECK ("team_retention"."period" IN ('30d', '90d', '1y', 'forever'))
);
--> statement-breakpoint
ALTER TABLE "retention_blob_deletions" ADD CONSTRAINT "retention_blob_deletions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_blob_deletions" ADD CONSTRAINT "retention_blob_deletions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_retention" ADD CONSTRAINT "team_retention_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_retention" ADD CONSTRAINT "team_retention_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retention_blob_deletions_queue_idx" ON "retention_blob_deletions" USING btree ("team_id","enqueued_at");--> statement-breakpoint
CREATE INDEX "thread_entries_blob_ref_idx" ON "thread_entries" USING btree ("team_id","blob_ref") WHERE "thread_entries"."blob_ref" IS NOT NULL;