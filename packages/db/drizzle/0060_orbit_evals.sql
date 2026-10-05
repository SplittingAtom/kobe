CREATE TABLE "orbit_evals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_scope" text NOT NULL,
	"agent_slug" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"draft_revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"threshold" double precision NOT NULL,
	"attack_success_rate" double precision,
	"attempts" integer,
	"attack_successes" integer,
	"report" jsonb,
	"error" text,
	"version" integer,
	"job_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "orbit_evals_scope" CHECK ("orbit_evals"."agent_scope" IN ('team', 'personal')),
	CONSTRAINT "orbit_evals_status" CHECK ("orbit_evals"."status" IN ('pending', 'running', 'passed', 'blocked', 'errored')),
	CONSTRAINT "orbit_evals_rate" CHECK (("orbit_evals"."attack_success_rate" IS NULL OR ("orbit_evals"."attack_success_rate" >= 0 AND "orbit_evals"."attack_success_rate" <= 1)) AND "orbit_evals"."threshold" >= 0 AND "orbit_evals"."threshold" <= 1),
	CONSTRAINT "orbit_evals_verdict" CHECK (("orbit_evals"."status" NOT IN ('passed', 'blocked') OR ("orbit_evals"."attack_success_rate" IS NOT NULL AND "orbit_evals"."finished_at" IS NOT NULL))
        AND ("orbit_evals"."status" <> 'errored' OR ("orbit_evals"."error" IS NOT NULL AND "orbit_evals"."finished_at" IS NOT NULL))
        AND ("orbit_evals"."version" IS NULL OR "orbit_evals"."status" = 'passed')),
	CONSTRAINT "orbit_evals_error_len" CHECK ("orbit_evals"."error" IS NULL OR char_length("orbit_evals"."error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "team_eval_settings" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_attack_success_rate" double precision DEFAULT 0.2 NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_eval_settings_asr" CHECK ("team_eval_settings"."max_attack_success_rate" >= 0 AND "team_eval_settings"."max_attack_success_rate" <= 1)
);
--> statement-breakpoint
ALTER TABLE "orbit_evals" ADD CONSTRAINT "orbit_evals_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orbit_evals" ADD CONSTRAINT "orbit_evals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_eval_settings" ADD CONSTRAINT "team_eval_settings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_eval_settings" ADD CONSTRAINT "team_eval_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orbit_evals_agent_idx" ON "orbit_evals" USING btree ("team_id","agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "orbit_evals_active_agent" ON "orbit_evals" USING btree ("team_id","agent_id") WHERE "orbit_evals"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "orbit_evals_version_idx" ON "orbit_evals" USING btree ("team_id","agent_id","version") WHERE "orbit_evals"."version" IS NOT NULL;