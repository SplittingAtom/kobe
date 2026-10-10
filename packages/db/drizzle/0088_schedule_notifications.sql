CREATE TABLE "notification_emails" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notification_emails_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "notification_emails_status" CHECK ("notification_emails"."status" IN ('pending', 'sent', 'failed', 'skipped')),
	CONSTRAINT "notification_emails_attempts" CHECK ("notification_emails"."attempts" >= 0),
	CONSTRAINT "notification_emails_error" CHECK ("notification_emails"."last_error" IS NULL OR "notification_emails"."last_error" ~ '^[a-z0-9_]{1,64}$'),
	CONSTRAINT "notification_emails_sent" CHECK (("notification_emails"."status" = 'sent') = ("notification_emails"."sent_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"schedule_id" uuid NOT NULL,
	"thread_id" uuid,
	"run_id" uuid,
	"skipped_count" integer,
	"paused_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "notifications_kind" CHECK ("notifications"."kind" IN ('schedule.run.succeeded', 'schedule.run.failed', 'schedule.run.interrupted', 'schedule.run.skipped_actions', 'schedule.paused')),
	CONSTRAINT "notifications_shape" CHECK (("notifications"."kind" = 'schedule.paused' AND "notifications"."thread_id" IS NULL AND "notifications"."run_id" IS NULL AND "notifications"."paused_by" IS NOT NULL)
        OR ("notifications"."kind" <> 'schedule.paused' AND "notifications"."thread_id" IS NOT NULL AND "notifications"."run_id" IS NOT NULL AND "notifications"."paused_by" IS NULL)),
	CONSTRAINT "notifications_paused_by" CHECK ("notifications"."paused_by" IN ('team_admin', 'deactivation')),
	CONSTRAINT "notifications_skipped_count" CHECK ("notifications"."skipped_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "run_skipped_actions" (
	"team_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool" text NOT NULL,
	"risk_class" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_skipped_actions_team_id_run_id_tool_call_id_pk" PRIMARY KEY("team_id","run_id","tool_call_id"),
	CONSTRAINT "run_skipped_actions_tool_call" CHECK (char_length("run_skipped_actions"."tool_call_id") BETWEEN 1 AND 200),
	CONSTRAINT "run_skipped_actions_tool" CHECK (char_length("run_skipped_actions"."tool") BETWEEN 1 AND 200),
	CONSTRAINT "run_skipped_actions_risk" CHECK ("run_skipped_actions"."risk_class" IN ('read', 'write', 'destructive')),
	CONSTRAINT "run_skipped_actions_reason" CHECK ("run_skipped_actions"."reason" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "notification_emails" ADD CONSTRAINT "notification_emails_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_emails" ADD CONSTRAINT "notification_emails_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_emails" ADD CONSTRAINT "notification_emails_notification_fk" FOREIGN KEY ("team_id","notification_id") REFERENCES "public"."notifications"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_schedule_fk" FOREIGN KEY ("team_id","schedule_id") REFERENCES "public"."schedules"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_skipped_actions" ADD CONSTRAINT "run_skipped_actions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_skipped_actions" ADD CONSTRAINT "run_skipped_actions_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_emails_once" ON "notification_emails" USING btree ("team_id","notification_id");--> statement-breakpoint
CREATE INDEX "notification_emails_due_idx" ON "notification_emails" USING btree ("team_id","next_attempt_at") WHERE "notification_emails"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_run_kind_uniq" ON "notifications" USING btree ("team_id","run_id","kind") WHERE "notifications"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("team_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("team_id","user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_thread_idx" ON "notifications" USING btree ("team_id","thread_id") WHERE "notifications"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notifications_schedule_idx" ON "notifications" USING btree ("team_id","schedule_id");