CREATE TABLE "skill_eval_results" (
	"team_id" uuid NOT NULL,
	"eval_run_id" uuid NOT NULL,
	"case_id" text NOT NULL,
	"with_skill" boolean NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt" smallint DEFAULT 1 NOT NULL,
	"thread_id" uuid,
	"run_id" uuid,
	"deadline_at" timestamp with time zone,
	"first_attempt" jsonb,
	"execution" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_eval_results_team_id_eval_run_id_case_id_with_skill_pk" PRIMARY KEY("team_id","eval_run_id","case_id","with_skill"),
	CONSTRAINT "skill_eval_results_case_id" CHECK ("skill_eval_results"."case_id" ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
	CONSTRAINT "skill_eval_results_state" CHECK ("skill_eval_results"."state" IN ('queued', 'starting', 'running', 'collecting', 'done')),
	CONSTRAINT "skill_eval_results_attempt" CHECK ("skill_eval_results"."attempt" IN (1, 2)),
	CONSTRAINT "skill_eval_results_done" CHECK (("skill_eval_results"."execution" IS NOT NULL) = ("skill_eval_results"."state" = 'done')
        AND ("skill_eval_results"."finished_at" IS NOT NULL) = ("skill_eval_results"."state" = 'done')),
	CONSTRAINT "skill_eval_results_json" CHECK (("skill_eval_results"."execution" IS NULL OR jsonb_typeof("skill_eval_results"."execution") = 'object')
        AND ("skill_eval_results"."first_attempt" IS NULL OR jsonb_typeof("skill_eval_results"."first_attempt") = 'object')
        AND ("skill_eval_results"."first_attempt" IS NULL OR "skill_eval_results"."attempt" = 2)),
	CONSTRAINT "skill_eval_results_live" CHECK ("skill_eval_results"."state" IN ('queued', 'done') OR "skill_eval_results"."deadline_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "skill_eval_runs" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"started_by" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_rev" integer NOT NULL,
	"skill_name" text NOT NULL,
	"package_hash" text NOT NULL,
	"runtime_hash" text NOT NULL,
	"bundle_key" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"suite" jsonb NOT NULL,
	"limits" jsonb NOT NULL,
	"run_model" jsonb,
	"judge_model" jsonb,
	"progress_total" integer NOT NULL,
	"progress_done" integer DEFAULT 0 NOT NULL,
	"scorecard" jsonb,
	"failure" jsonb,
	"cancel_requested_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_eval_runs_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "skill_eval_runs_subject_kind" CHECK ("skill_eval_runs"."subject_kind" IN ('draft', 'team', 'personal')),
	CONSTRAINT "skill_eval_runs_subject_rev" CHECK ("skill_eval_runs"."subject_rev" >= 1),
	CONSTRAINT "skill_eval_runs_mode" CHECK ("skill_eval_runs"."mode" IN ('full', 'with_only')),
	CONSTRAINT "skill_eval_runs_status" CHECK ("skill_eval_runs"."status" IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'budget_stopped')),
	CONSTRAINT "skill_eval_runs_name" CHECK ("skill_eval_runs"."skill_name" ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
	CONSTRAINT "skill_eval_runs_hashes" CHECK ("skill_eval_runs"."package_hash" ~ '^[0-9a-f]{64}$' AND "skill_eval_runs"."runtime_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_eval_runs_bundle_key" CHECK (char_length("skill_eval_runs"."bundle_key") BETWEEN 1 AND 512),
	CONSTRAINT "skill_eval_runs_json" CHECK (jsonb_typeof("skill_eval_runs"."suite") = 'object' AND jsonb_typeof("skill_eval_runs"."limits") = 'object'
        AND ("skill_eval_runs"."run_model" IS NULL OR jsonb_typeof("skill_eval_runs"."run_model") = 'object')
        AND ("skill_eval_runs"."judge_model" IS NULL OR jsonb_typeof("skill_eval_runs"."judge_model") = 'object')
        AND ("skill_eval_runs"."scorecard" IS NULL OR jsonb_typeof("skill_eval_runs"."scorecard") = 'object')
        AND ("skill_eval_runs"."failure" IS NULL OR jsonb_typeof("skill_eval_runs"."failure") = 'object')),
	CONSTRAINT "skill_eval_runs_progress" CHECK ("skill_eval_runs"."progress_done" >= 0 AND "skill_eval_runs"."progress_done" <= "skill_eval_runs"."progress_total"
        AND "skill_eval_runs"."progress_total" BETWEEN 1 AND 50),
	CONSTRAINT "skill_eval_runs_outcome" CHECK (("skill_eval_runs"."scorecard" IS NOT NULL) = ("skill_eval_runs"."status" = 'completed')
        AND ("skill_eval_runs"."failure" IS NOT NULL) = ("skill_eval_runs"."status" IN ('failed', 'budget_stopped'))
        AND ("skill_eval_runs"."finished_at" IS NOT NULL) = ("skill_eval_runs"."status" IN ('completed', 'failed', 'cancelled', 'budget_stopped'))),
	CONSTRAINT "skill_eval_runs_scorecard_size" CHECK ("skill_eval_runs"."scorecard" IS NULL OR pg_column_size("skill_eval_runs"."scorecard") <= 1048576)
);
--> statement-breakpoint
DROP INDEX "sandbox_commands_open_idx";--> statement-breakpoint
DROP INDEX "sandbox_run_leases_user_idx";--> statement-breakpoint
ALTER TABLE "sandbox_connections" DROP CONSTRAINT "sandbox_connections_team_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "skill_eval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "skill_eval_run_id" uuid;--> statement-breakpoint
ALTER TABLE "sandbox_commands" ADD COLUMN "slot" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_connections" ADD COLUMN "slot" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_run_leases" ADD COLUMN "slot" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_eval_results" ADD CONSTRAINT "skill_eval_results_run_fk" FOREIGN KEY ("team_id","eval_run_id") REFERENCES "public"."skill_eval_runs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_eval_runs" ADD CONSTRAINT "skill_eval_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_eval_runs" ADD CONSTRAINT "skill_eval_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_eval_results_open_idx" ON "skill_eval_results" USING btree ("team_id","state") WHERE "skill_eval_results"."state" <> 'done';--> statement-breakpoint
CREATE INDEX "skill_eval_results_thread_idx" ON "skill_eval_results" USING btree ("team_id","thread_id") WHERE "skill_eval_results"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "skill_eval_runs_subject_idx" ON "skill_eval_runs" USING btree ("team_id","subject_kind","subject_id","started_at");--> statement-breakpoint
CREATE INDEX "skill_eval_runs_open_idx" ON "skill_eval_runs" USING btree ("team_id","started_at") WHERE "skill_eval_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "skill_eval_runs_starter_idx" ON "skill_eval_runs" USING btree ("team_id","started_by");--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_connections_key" ON "sandbox_connections" USING btree ("team_id","user_id","slot");--> statement-breakpoint
CREATE INDEX "sandbox_commands_open_idx" ON "sandbox_commands" USING btree ("team_id","user_id","slot","created_at") WHERE "sandbox_commands"."status" IN ('pending', 'delivered');--> statement-breakpoint
CREATE INDEX "sandbox_run_leases_user_idx" ON "sandbox_run_leases" USING btree ("team_id","user_id","slot");--> statement-breakpoint
ALTER TABLE "sandbox_commands" ADD CONSTRAINT "sandbox_commands_slot" CHECK ("sandbox_commands"."slot" ~ '^(|e-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');--> statement-breakpoint
ALTER TABLE "sandbox_connections" ADD CONSTRAINT "sandbox_connections_slot" CHECK ("sandbox_connections"."slot" ~ '^(|e-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');--> statement-breakpoint
ALTER TABLE "sandbox_run_leases" ADD CONSTRAINT "sandbox_run_leases_slot" CHECK ("sandbox_run_leases"."slot" ~ '^(|e-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');