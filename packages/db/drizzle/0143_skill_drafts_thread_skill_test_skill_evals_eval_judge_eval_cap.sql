CREATE TABLE "skill_draft_file_history" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"written_by" uuid NOT NULL,
	"path" text NOT NULL,
	"text_content" text,
	"bytes" "bytea",
	"size" integer NOT NULL,
	"change" text NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	"kept_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_draft_file_history_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "skill_draft_file_history_change" CHECK ("skill_draft_file_history"."change" IN ('overwritten', 'deleted')),
	CONSTRAINT "skill_draft_file_history_one_content" CHECK (("skill_draft_file_history"."text_content" IS NULL) <> ("skill_draft_file_history"."bytes" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "skill_draft_files" (
	"team_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"path" text NOT NULL,
	"text_content" text,
	"bytes" "bytea",
	"size" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "skill_draft_files_team_id_draft_id_path_pk" PRIMARY KEY("team_id","draft_id","path"),
	CONSTRAINT "skill_draft_files_path_size" CHECK (octet_length("skill_draft_files"."path") BETWEEN 1 AND 240),
	CONSTRAINT "skill_draft_files_one_content" CHECK (("skill_draft_files"."text_content" IS NULL) <> ("skill_draft_files"."bytes" IS NULL)),
	CONSTRAINT "skill_draft_files_size" CHECK ("skill_draft_files"."size" = COALESCE(octet_length("skill_draft_files"."text_content"), octet_length("skill_draft_files"."bytes")) AND "skill_draft_files"."size" <= 5242880)
);
--> statement-breakpoint
CREATE TABLE "skill_draft_history" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"name" text NOT NULL,
	"shared" boolean NOT NULL,
	"started_from" text NOT NULL,
	"parent_ref" jsonb,
	"from_thread_id" uuid,
	"rev" integer NOT NULL,
	"change" text NOT NULL,
	"draft_created_at" timestamp with time zone NOT NULL,
	"draft_updated_at" timestamp with time zone NOT NULL,
	"kept_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_draft_history_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "skill_draft_history_change" CHECK ("skill_draft_history"."change" IN ('changed', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "skill_drafts" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"started_from" text DEFAULT 'blank' NOT NULL,
	"parent_ref" jsonb,
	"from_thread_id" uuid,
	"co_edited" boolean DEFAULT false NOT NULL,
	"owner_departed_at" timestamp with time zone,
	"rev" integer DEFAULT 1 NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "skill_drafts_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "skill_drafts_name_format" CHECK ("skill_drafts"."name" ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
	CONSTRAINT "skill_drafts_started_from" CHECK ("skill_drafts"."started_from" IN ('blank', 'template', 'thread', 'fork', 'upload', 'git')),
	CONSTRAINT "skill_drafts_parent_ref" CHECK ("skill_drafts"."parent_ref" IS NULL OR (jsonb_typeof("skill_drafts"."parent_ref") = 'object' AND octet_length("skill_drafts"."parent_ref"::text) <= 4096)),
	CONSTRAINT "skill_drafts_provenance" CHECK (("skill_drafts"."started_from" = 'thread') = ("skill_drafts"."from_thread_id" IS NOT NULL) AND ("skill_drafts"."started_from" = 'fork') = ("skill_drafts"."parent_ref" IS NOT NULL)),
	CONSTRAINT "skill_drafts_rev_positive" CHECK ("skill_drafts"."rev" > 0),
	CONSTRAINT "skill_drafts_size" CHECK ("skill_drafts"."size_bytes" BETWEEN 0 AND 5242880 AND "skill_drafts"."file_count" BETWEEN 0 AND 200)
);
--> statement-breakpoint
CREATE TABLE "skill_eval_results" (
	"team_id" uuid NOT NULL,
	"eval_run_id" uuid NOT NULL,
	"case_id" text NOT NULL,
	"with_skill" boolean NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt" smallint DEFAULT 1 NOT NULL,
	"takeovers" smallint DEFAULT 0 NOT NULL,
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
	CONSTRAINT "skill_eval_results_takeovers" CHECK ("skill_eval_results"."takeovers" BETWEEN 0 AND 100),
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
	"bundle_size" integer NOT NULL,
	"fixtures_key" text,
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
	CONSTRAINT "skill_eval_runs_keys" CHECK (char_length("skill_eval_runs"."bundle_key") BETWEEN 1 AND 512 AND "skill_eval_runs"."bundle_size" > 0
        AND ("skill_eval_runs"."fixtures_key" IS NULL OR char_length("skill_eval_runs"."fixtures_key") BETWEEN 1 AND 512)),
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
CREATE TABLE "sandbox_eval_connections" (
	"team_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"replica_id" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "sandbox_eval_connections_team_id_thread_id_pk" PRIMARY KEY("team_id","thread_id"),
	CONSTRAINT "sandbox_eval_connections_replica_id" CHECK (char_length("sandbox_eval_connections"."replica_id") BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "sandbox_commands" DROP CONSTRAINT "sandbox_commands_kind";--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "skill_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "skill_draft_id" uuid;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "skill_eval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "skill_eval_run_id" uuid;--> statement-breakpoint
ALTER TABLE "sandbox_commands" ADD COLUMN "slot" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_run_leases" ADD COLUMN "slot" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_spend_daily" ADD COLUMN "eval_cost_usd" numeric(24, 10) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_spend_daily" ADD COLUMN "eval_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_skill_settings" ADD COLUMN "eval_judge_alias" text;--> statement-breakpoint
ALTER TABLE "team_skill_settings" ADD COLUMN "eval_cap_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "team_skill_settings" ADD COLUMN "eval_cap_tokens" bigint;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD COLUMN "eval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_draft_file_history" ADD CONSTRAINT "skill_draft_file_history_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_draft_file_history" ADD CONSTRAINT "skill_draft_file_history_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_draft_file_history" ADD CONSTRAINT "skill_draft_file_history_written_by_users_id_fk" FOREIGN KEY ("written_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_draft_files" ADD CONSTRAINT "skill_draft_files_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_draft_files" ADD CONSTRAINT "skill_draft_files_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_draft_files" ADD CONSTRAINT "skill_draft_files_draft_fk" FOREIGN KEY ("team_id","draft_id") REFERENCES "public"."skill_drafts"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_draft_history" ADD CONSTRAINT "skill_draft_history_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_draft_history" ADD CONSTRAINT "skill_draft_history_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_draft_history" ADD CONSTRAINT "skill_draft_history_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD CONSTRAINT "skill_drafts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD CONSTRAINT "skill_drafts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD CONSTRAINT "skill_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_eval_results" ADD CONSTRAINT "skill_eval_results_run_fk" FOREIGN KEY ("team_id","eval_run_id") REFERENCES "public"."skill_eval_runs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_eval_runs" ADD CONSTRAINT "skill_eval_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_eval_runs" ADD CONSTRAINT "skill_eval_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_eval_connections" ADD CONSTRAINT "sandbox_eval_connections_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_eval_connections" ADD CONSTRAINT "sandbox_eval_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_eval_connections" ADD CONSTRAINT "sandbox_eval_connections_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_draft_file_history_owner_idx" ON "skill_draft_file_history" USING btree ("team_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "skill_draft_file_history_writer_idx" ON "skill_draft_file_history" USING btree ("team_id","written_by");--> statement-breakpoint
CREATE INDEX "skill_draft_files_writer_idx" ON "skill_draft_files" USING btree ("team_id","updated_by");--> statement-breakpoint
CREATE INDEX "skill_draft_history_owner_idx" ON "skill_draft_history" USING btree ("team_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "skill_draft_history_writer_idx" ON "skill_draft_history" USING btree ("team_id","updated_by");--> statement-breakpoint
CREATE INDEX "skill_drafts_owner_idx" ON "skill_drafts" USING btree ("team_id","owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "skill_drafts_updated_idx" ON "skill_drafts" USING btree ("team_id","updated_at");--> statement-breakpoint
CREATE INDEX "skill_eval_results_open_idx" ON "skill_eval_results" USING btree ("team_id","state") WHERE "skill_eval_results"."state" <> 'done';--> statement-breakpoint
CREATE INDEX "skill_eval_results_thread_idx" ON "skill_eval_results" USING btree ("team_id","thread_id") WHERE "skill_eval_results"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "skill_eval_runs_subject_idx" ON "skill_eval_runs" USING btree ("team_id","subject_kind","subject_id","started_at");--> statement-breakpoint
CREATE INDEX "skill_eval_runs_open_idx" ON "skill_eval_runs" USING btree ("team_id","started_at") WHERE "skill_eval_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "skill_eval_runs_starter_idx" ON "skill_eval_runs" USING btree ("team_id","started_by");--> statement-breakpoint
CREATE INDEX "sandbox_eval_connections_user_idx" ON "sandbox_eval_connections" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE INDEX "sandbox_eval_connections_sandbox_idx" ON "sandbox_eval_connections" USING btree ("team_id","sandbox_id");--> statement-breakpoint
ALTER TABLE "sandbox_commands" ADD CONSTRAINT "sandbox_commands_kind" CHECK ("sandbox_commands"."kind" IN ('run.start', 'run.steer', 'run.stop', 'pi.command', 'thread.compact', 'eval.prepare', 'eval.snapshot', 'eval.read'));--> statement-breakpoint
ALTER TABLE "team_skill_settings" ADD CONSTRAINT "team_skill_settings_eval_judge_alias" CHECK ("team_skill_settings"."eval_judge_alias" IS NULL OR char_length("team_skill_settings"."eval_judge_alias") BETWEEN 1 AND 64);--> statement-breakpoint
ALTER TABLE "team_skill_settings" ADD CONSTRAINT "team_skill_settings_eval_cap" CHECK (("team_skill_settings"."eval_cap_usd" IS NULL OR "team_skill_settings"."eval_cap_tokens" IS NULL)
        AND ("team_skill_settings"."eval_cap_usd" IS NULL OR ("team_skill_settings"."eval_cap_usd" > 0 AND "team_skill_settings"."eval_cap_usd" <= 1000000))
        AND ("team_skill_settings"."eval_cap_tokens" IS NULL OR "team_skill_settings"."eval_cap_tokens" BETWEEN 1 AND 1000000000000));