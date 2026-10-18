CREATE TABLE "skill_default_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"major" integer,
	"version_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"teams_total" integer DEFAULT 0 NOT NULL,
	"teams_done" integer DEFAULT 0 NOT NULL,
	"after_team_id" uuid,
	"installed" integer DEFAULT 0 NOT NULL,
	"kept" integer DEFAULT 0 NOT NULL,
	"opted_out" integer DEFAULT 0 NOT NULL,
	"converted" integer DEFAULT 0 NOT NULL,
	"optouts_cleared" integer DEFAULT 0 NOT NULL,
	"moved" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "skill_default_syncs_kind" CHECK ("skill_default_syncs"."kind" IN ('add', 'remove', 'move_major')),
	CONSTRAINT "skill_default_syncs_status" CHECK ("skill_default_syncs"."status" IN ('queued', 'running', 'done')),
	CONSTRAINT "skill_default_syncs_target" CHECK (("skill_default_syncs"."kind" = 'remove') = ("skill_default_syncs"."major" IS NULL AND "skill_default_syncs"."version_id" IS NULL)
        AND ("skill_default_syncs"."major" IS NULL OR "skill_default_syncs"."major" >= 0)),
	CONSTRAINT "skill_default_syncs_times" CHECK (("skill_default_syncs"."status" = 'queued') = ("skill_default_syncs"."started_at" IS NULL)
        AND ("skill_default_syncs"."status" = 'done') = ("skill_default_syncs"."finished_at" IS NOT NULL)),
	CONSTRAINT "skill_default_syncs_counts" CHECK ("skill_default_syncs"."teams_total" >= 0 AND "skill_default_syncs"."teams_done" >= 0 AND "skill_default_syncs"."installed" >= 0 AND "skill_default_syncs"."kept" >= 0
        AND "skill_default_syncs"."opted_out" >= 0 AND "skill_default_syncs"."converted" >= 0 AND "skill_default_syncs"."optouts_cleared" >= 0
        AND "skill_default_syncs"."moved" >= 0)
);
--> statement-breakpoint
ALTER TABLE "skill_default_syncs" ADD CONSTRAINT "skill_default_syncs_skill_id_registry_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."registry_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_default_syncs" ADD CONSTRAINT "skill_default_syncs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_default_syncs" ADD CONSTRAINT "skill_default_syncs_version_fk" FOREIGN KEY ("version_id","skill_id") REFERENCES "public"."registry_versions"("id","skill_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_default_syncs_queue_idx" ON "skill_default_syncs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "skill_default_syncs_skill_idx" ON "skill_default_syncs" USING btree ("skill_id","created_at");