CREATE TABLE "budget_alert_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "budget_alert_emails_once" UNIQUE("alert_id","recipient_id"),
	CONSTRAINT "budget_alert_emails_status" CHECK ("budget_alert_emails"."status" IN ('pending', 'sent', 'skipped', 'failed')),
	CONSTRAINT "budget_alert_emails_error" CHECK ("budget_alert_emails"."last_error" IS NULL OR "budget_alert_emails"."last_error" ~ '^[a-z0-9_]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "budget_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid,
	"user_id" uuid,
	"scope" text NOT NULL,
	"period" text NOT NULL,
	"period_start" date NOT NULL,
	"threshold" smallint NOT NULL,
	"limit_usd" numeric(14, 2) NOT NULL,
	"spent_usd" numeric(24, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_alerts_once" UNIQUE NULLS NOT DISTINCT("team_id","user_id","scope","period","period_start","threshold"),
	CONSTRAINT "budget_alerts_scope" CHECK ("budget_alerts"."scope" IN ('install', 'team', 'user')),
	CONSTRAINT "budget_alerts_period" CHECK ("budget_alerts"."period" IN ('month', 'day')),
	CONSTRAINT "budget_alerts_threshold" CHECK ("budget_alerts"."threshold" IN (80, 100)),
	CONSTRAINT "budget_alerts_crossed" CHECK ("budget_alerts"."spent_usd" >= "budget_alerts"."limit_usd" * "budget_alerts"."threshold" / 100),
	CONSTRAINT "budget_alerts_subject" CHECK (("budget_alerts"."scope" = 'install' AND "budget_alerts"."team_id" IS NULL AND "budget_alerts"."user_id" IS NULL)
        OR ("budget_alerts"."scope" = 'team' AND "budget_alerts"."team_id" IS NOT NULL AND "budget_alerts"."user_id" IS NULL)
        OR ("budget_alerts"."scope" = 'user' AND "budget_alerts"."team_id" IS NOT NULL AND "budget_alerts"."user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "install_model_limits" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"monthly_usd" numeric(14, 2),
	"daily_usd" numeric(14, 2),
	"user_requests_per_minute" integer DEFAULT 60 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "install_model_limits_singleton" CHECK ("install_model_limits"."id" = 1),
	CONSTRAINT "install_model_limits_amounts" CHECK (("install_model_limits"."monthly_usd" IS NULL OR "install_model_limits"."monthly_usd" BETWEEN 0 AND 1000000000) AND ("install_model_limits"."daily_usd" IS NULL OR "install_model_limits"."daily_usd" BETWEEN 0 AND 1000000000)),
	CONSTRAINT "install_model_limits_rpm" CHECK (("install_model_limits"."user_requests_per_minute" IS NULL OR "install_model_limits"."user_requests_per_minute" BETWEEN 1 AND 10000))
);
--> statement-breakpoint
CREATE TABLE "install_model_spend_daily" (
	"day" date PRIMARY KEY NOT NULL,
	"cost_usd" numeric(24, 10) DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_spend_daily" (
	"team_id" uuid NOT NULL,
	"day" date NOT NULL,
	"user_id" uuid NOT NULL,
	"cost_usd" numeric(24, 10) DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "model_spend_daily_team_id_day_user_id_pk" PRIMARY KEY("team_id","day","user_id")
);
--> statement-breakpoint
CREATE TABLE "team_budgets" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"monthly_usd" numeric(14, 2),
	"daily_usd" numeric(14, 2),
	"user_requests_per_minute" integer,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_budgets_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "team_budgets_amounts" CHECK (("team_budgets"."monthly_usd" IS NULL OR "team_budgets"."monthly_usd" BETWEEN 0 AND 1000000000) AND ("team_budgets"."daily_usd" IS NULL OR "team_budgets"."daily_usd" BETWEEN 0 AND 1000000000)),
	CONSTRAINT "team_budgets_rpm" CHECK (("team_budgets"."user_requests_per_minute" IS NULL OR "team_budgets"."user_requests_per_minute" BETWEEN 1 AND 10000)),
	CONSTRAINT "team_budgets_rpm_team_only" CHECK ("team_budgets"."user_requests_per_minute" IS NULL OR "team_budgets"."user_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "budget_alert_emails" ADD CONSTRAINT "budget_alert_emails_alert_id_budget_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."budget_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alert_emails" ADD CONSTRAINT "budget_alert_emails_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "install_model_limits" ADD CONSTRAINT "install_model_limits_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_spend_daily" ADD CONSTRAINT "model_spend_daily_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_budgets" ADD CONSTRAINT "team_budgets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_budgets" ADD CONSTRAINT "team_budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_budgets" ADD CONSTRAINT "team_budgets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_alert_emails_due_idx" ON "budget_alert_emails" USING btree ("next_attempt_at") WHERE "budget_alert_emails"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "budget_alerts_team_idx" ON "budget_alerts" USING btree ("team_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "team_budgets_team_idx" ON "team_budgets" USING btree ("team_id") WHERE "team_budgets"."user_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "team_budgets_user_idx" ON "team_budgets" USING btree ("team_id","user_id") WHERE "team_budgets"."user_id" IS NOT NULL;