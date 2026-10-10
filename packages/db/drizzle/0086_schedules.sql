CREATE TABLE "schedules" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"recurrence" jsonb NOT NULL,
	"cron" text,
	"tz" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notify_email" boolean DEFAULT true NOT NULL,
	"paused_by" text,
	"next_due_at" timestamp with time zone,
	"last_run_id" uuid,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "schedules_prompt" CHECK (char_length(btrim("schedules"."prompt")) BETWEEN 1 AND 10000),
	CONSTRAINT "schedules_tz" CHECK (char_length("schedules"."tz") BETWEEN 1 AND 64),
	CONSTRAINT "schedules_paused_by" CHECK ("schedules"."paused_by" IN ('team_admin', 'deactivation')),
	CONSTRAINT "schedules_paused_inactive" CHECK ("schedules"."paused_by" IS NULL OR NOT "schedules"."active")
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("team_id","next_due_at") WHERE "schedules"."active" AND "schedules"."next_due_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "schedules_user_idx" ON "schedules" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE INDEX "schedules_agent_idx" ON "schedules" USING btree ("team_id","agent_id");--> statement-breakpoint
CREATE INDEX "threads_schedule_idx" ON "threads" USING btree ("team_id","schedule_id","last_activity_at" DESC NULLS LAST) WHERE "threads"."schedule_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_schedule_fire_keys" CHECK ("events"."kind" <> 'schedule.fire' OR ("events"."ref"->>'schedule_id' IS NOT NULL AND "events"."due_at" IS NOT NULL));