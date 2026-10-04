CREATE TYPE "public"."egress_request_notification_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."egress_request_status" AS ENUM('pending', 'approved', 'denied');--> statement-breakpoint
CREATE TABLE "egress_request_notifications" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"event" text NOT NULL,
	"recipient_id" uuid NOT NULL,
	"status" "egress_request_notification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "egress_request_notifications_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "egress_request_notifications_event" CHECK ("egress_request_notifications"."event" IN ('requested', 'approved', 'denied')),
	CONSTRAINT "egress_request_notifications_last_error" CHECK (char_length("egress_request_notifications"."last_error") <= 64)
);
--> statement-breakpoint
CREATE TABLE "egress_requests" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"pattern" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"thread_id" uuid,
	"status" "egress_request_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "egress_requests_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "egress_requests_domain" CHECK (char_length("egress_requests"."domain") <= 253 AND "egress_requests"."domain" ~ '^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "egress_requests_pattern" CHECK (char_length("egress_requests"."pattern") <= 253 AND "egress_requests"."pattern" ~ '^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "egress_requests_decided" CHECK (("egress_requests"."status" = 'pending') = ("egress_requests"."decided_at" IS NULL) AND ("egress_requests"."status" = 'pending' OR "egress_requests"."decided_by" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "team_egress" ADD COLUMN "header_names" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "team_egress" ADD COLUMN "headers_sealed" text;--> statement-breakpoint
ALTER TABLE "team_egress" ADD COLUMN "headers_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "team_egress" ADD COLUMN "headers_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "egress_request_notifications" ADD CONSTRAINT "egress_request_notifications_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_request_notifications" ADD CONSTRAINT "egress_request_notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_request_notifications" ADD CONSTRAINT "egress_request_notifications_team_id_request_id_egress_requests_team_id_id_fk" FOREIGN KEY ("team_id","request_id") REFERENCES "public"."egress_requests"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_requests" ADD CONSTRAINT "egress_requests_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_requests" ADD CONSTRAINT "egress_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_requests" ADD CONSTRAINT "egress_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "egress_request_notifications_due_idx" ON "egress_request_notifications" USING btree ("team_id","next_attempt_at") WHERE "egress_request_notifications"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "egress_requests_pending_key" ON "egress_requests" USING btree ("team_id","requested_by","pattern") WHERE "egress_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "egress_requests_team_status_idx" ON "egress_requests" USING btree ("team_id","status","created_at");--> statement-breakpoint
ALTER TABLE "team_egress" ADD CONSTRAINT "team_egress_headers_updated_by_users_id_fk" FOREIGN KEY ("headers_updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_egress" ADD CONSTRAINT "team_egress_headers" CHECK (cardinality("team_egress"."header_names") <= 8 AND ("team_egress"."headers_sealed" IS NULL) = (cardinality("team_egress"."header_names") = 0) AND ("team_egress"."headers_sealed" IS NULL OR char_length("team_egress"."headers_sealed") <= 65536));