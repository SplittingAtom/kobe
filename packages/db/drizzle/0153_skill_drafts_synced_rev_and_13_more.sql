ALTER TYPE "public"."registry_review_action" ADD VALUE 'undeprecated';--> statement-breakpoint
ALTER TYPE "public"."registry_review_action" ADD VALUE 'finding_acknowledged';--> statement-breakpoint
ALTER TYPE "public"."registry_review_action" ADD VALUE 'retracted';--> statement-breakpoint
ALTER TYPE "public"."registry_version_state" ADD VALUE 'retracted';--> statement-breakpoint
CREATE TABLE "team_skill_requests" (
	"team_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "team_skill_requests_team_id_skill_id_user_id_pk" PRIMARY KEY("team_id","skill_id","user_id"),
	CONSTRAINT "team_skill_requests_order" CHECK ("team_skill_requests"."first_at" <= "team_skill_requests"."last_at")
);
--> statement-breakpoint
CREATE TABLE "skill_promotion_requests" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"semver" text NOT NULL,
	"package_hash" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"registry_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_promotion_requests_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "skill_promotion_requests_state" CHECK ("skill_promotion_requests"."state" IN ('pending', 'confirmed', 'declined', 'cancelled')),
	CONSTRAINT "skill_promotion_requests_decision" CHECK (("skill_promotion_requests"."state" = 'pending') = ("skill_promotion_requests"."decided_at" IS NULL)
        AND ("skill_promotion_requests"."decided_at" IS NULL) = ("skill_promotion_requests"."decided_by" IS NULL)
        AND ("skill_promotion_requests"."state" = 'confirmed') = ("skill_promotion_requests"."registry_version_id" IS NOT NULL)),
	CONSTRAINT "skill_promotion_requests_note" CHECK ("skill_promotion_requests"."note" IS NULL OR char_length("skill_promotion_requests"."note") BETWEEN 1 AND 1000),
	CONSTRAINT "skill_promotion_requests_version" CHECK ("skill_promotion_requests"."version" > 0),
	CONSTRAINT "skill_promotion_requests_hash" CHECK ("skill_promotion_requests"."package_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "skill_usage_snapshots" (
	"window_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "skill_usage_snapshots_window" CHECK ("skill_usage_snapshots"."window_start" < "skill_usage_snapshots"."window_end")
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_shape";--> statement-breakpoint
ALTER TABLE "registry_versions" DROP CONSTRAINT "registry_versions_review";--> statement-breakpoint
ALTER TABLE "skill_eval_runs" DROP CONSTRAINT "skill_eval_runs_subject_kind";--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "added_via" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "registry" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ADD COLUMN "from_conversation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD COLUMN "from_conversation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_skill_settings" ADD COLUMN "builders_may_promote" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "skill_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "skill_semver" text;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD COLUMN "synced_rev" integer;--> statement-breakpoint
ALTER TABLE "team_skill_requests" ADD CONSTRAINT "team_skill_requests_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_requests" ADD CONSTRAINT "team_skill_requests_skill_id_registry_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."registry_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_requests" ADD CONSTRAINT "team_skill_requests_member_fk" FOREIGN KEY ("team_id","user_id") REFERENCES "public"."team_members"("team_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_promotion_requests" ADD CONSTRAINT "skill_promotion_requests_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_promotion_requests" ADD CONSTRAINT "skill_promotion_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_promotion_requests" ADD CONSTRAINT "skill_promotion_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_promotion_requests" ADD CONSTRAINT "skill_promotion_requests_registry_version_id_registry_versions_id_fk" FOREIGN KEY ("registry_version_id") REFERENCES "public"."registry_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_promotion_requests" ADD CONSTRAINT "skill_promotion_requests_skill_fk" FOREIGN KEY ("team_id","skill_id") REFERENCES "public"."team_skills"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_skill_requests_open_idx" ON "team_skill_requests" USING btree ("team_id","last_at" DESC NULLS LAST) WHERE "team_skill_requests"."dismissed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "team_skill_requests_member_idx" ON "team_skill_requests" USING btree ("team_id","user_id","last_at");--> statement-breakpoint
CREATE INDEX "skill_promotion_requests_queue_idx" ON "skill_promotion_requests" USING btree ("team_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_promotion_requests_open_uq" ON "skill_promotion_requests" USING btree ("team_id","skill_id","version") WHERE "skill_promotion_requests"."state" = 'pending';--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_skill_id_registry_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."registry_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "teams_registry_uq" ON "teams" USING btree ("registry") WHERE "teams"."registry";--> statement-breakpoint
CREATE UNIQUE INDEX "skill_drafts_thread_sync_uq" ON "skill_drafts" USING btree ("team_id","owner_user_id","from_thread_id","name") WHERE "skill_drafts"."from_thread_id" IS NOT NULL AND "skill_drafts"."synced_rev" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_added_via" CHECK ("team_members"."added_via" IS NULL OR "team_members"."added_via" = 'skill_reviewer_grant');--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_skill_semver" CHECK ("notifications"."skill_semver" IS NULL OR char_length("notifications"."skill_semver") BETWEEN 5 AND 32);--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind" CHECK ("notifications"."kind" IN ('schedule.run.succeeded', 'schedule.run.failed', 'schedule.run.interrupted', 'schedule.run.skipped_actions', 'schedule.paused', 'skill.member_add.blocked', 'skill.deprecated', 'skill.version.deprecated', 'skill.version.withdrawn', 'skill.version.revoked', 'skill.version.unrevoked'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_shape" CHECK (("notifications"."kind" = 'schedule.paused' AND "notifications"."thread_id" IS NULL AND "notifications"."run_id" IS NULL AND "notifications"."paused_by" IS NOT NULL AND "notifications"."skill_id" IS NULL AND "notifications"."skill_semver" IS NULL)
        OR ("notifications"."kind" LIKE 'skill.%' AND "notifications"."schedule_id" IS NULL AND "notifications"."thread_id" IS NULL AND "notifications"."run_id" IS NULL AND "notifications"."paused_by" IS NULL AND "notifications"."skill_id" IS NOT NULL
          AND ("notifications"."skill_semver" IS NOT NULL) = ("notifications"."kind" LIKE 'skill.version.%'))
        OR ("notifications"."kind" <> 'schedule.paused' AND "notifications"."kind" NOT LIKE 'skill.%' AND "notifications"."thread_id" IS NOT NULL AND "notifications"."run_id" IS NOT NULL AND "notifications"."paused_by" IS NULL AND "notifications"."skill_id" IS NULL AND "notifications"."skill_semver" IS NULL));--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_review" CHECK ("registry_versions"."reviewed_by" IS NULL OR "registry_versions"."approved_at" IS NULL
        OR ("registry_versions"."reviewed_by" = "registry_versions"."submitted_by"
          OR COALESCE("registry_versions"."reviewed_by"::text = "registry_versions"."provenance" #>> '{confirmedBy,userId}', false))
          = "registry_versions"."self_approved");--> statement-breakpoint
ALTER TABLE "skill_eval_runs" ADD CONSTRAINT "skill_eval_runs_subject_kind" CHECK ("skill_eval_runs"."subject_kind" IN ('draft', 'team', 'personal', 'registry'));