CREATE TYPE "public"."thread_status" AS ENUM('idle', 'running', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted', 'cancelled', 'budget_stopped');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('user', 'schedule');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('pending', 'processed', 'failed', 'scheduled');--> statement-breakpoint
CREATE TABLE "thread_entries" (
	"team_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"entry_id" text NOT NULL,
	"parent_id" text,
	"seq" integer DEFAULT 0 NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blob_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_entries_team_id_thread_id_entry_id_pk" PRIMARY KEY("team_id","thread_id","entry_id"),
	CONSTRAINT "thread_entries_seq_unique" UNIQUE("team_id","thread_id","seq"),
	CONSTRAINT "thread_entries_seq_positive" CHECK ("thread_entries"."seq" > 0),
	CONSTRAINT "thread_entries_entry_id_length" CHECK (char_length("thread_entries"."entry_id") BETWEEN 1 AND 128),
	CONSTRAINT "thread_entries_type_nonempty" CHECK ("thread_entries"."type" <> '')
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid,
	"agent_id" uuid,
	"agent_version" integer,
	"title" text,
	"leaf_entry_id" text,
	"status" "thread_status" DEFAULT 'idle' NOT NULL,
	"shared_to_project" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_entry_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "threads_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "threads_agent_pin" CHECK (("threads"."agent_id" IS NULL) = ("threads"."agent_version" IS NULL) AND ("threads"."agent_version" IS NULL OR "threads"."agent_version" > 0)),
	CONSTRAINT "threads_last_entry_seq" CHECK ("threads"."last_entry_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"team_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_team_id_run_id_seq_pk" PRIMARY KEY("team_id","run_id","seq"),
	CONSTRAINT "run_events_seq_positive" CHECK ("run_events"."seq" > 0),
	CONSTRAINT "run_events_type_format" CHECK ("run_events"."type" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$')
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"queue_pos" integer,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"events_compacted_at" timestamp with time zone,
	CONSTRAINT "runs_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "runs_ended_at" CHECK (("runs"."status" IN ('completed', 'failed', 'interrupted', 'cancelled', 'budget_stopped')) = ("runs"."ended_at" IS NOT NULL)),
	CONSTRAINT "runs_started_at" CHECK ("runs"."status" NOT IN ('running', 'waiting_approval') OR "runs"."started_at" IS NOT NULL),
	CONSTRAINT "runs_queue_pos" CHECK ("runs"."queue_pos" IS NULL OR "runs"."status" = 'queued'),
	CONSTRAINT "runs_last_seq" CHECK ("runs"."last_seq" >= 0),
	CONSTRAINT "runs_events_compacted_at" CHECK ("runs"."events_compacted_at" IS NULL OR "runs"."ended_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" "event_status" DEFAULT 'pending' NOT NULL,
	"ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "events_due_at" CHECK ("events"."status" <> 'scheduled' OR "events"."due_at" IS NOT NULL),
	CONSTRAINT "events_kind_format" CHECK ("events"."kind" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)*$')
);
--> statement-breakpoint
ALTER TABLE "thread_entries" ADD CONSTRAINT "thread_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_entries" ADD CONSTRAINT "thread_entries_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_entries" ADD CONSTRAINT "thread_entries_parent_fk" FOREIGN KEY ("team_id","thread_id","parent_id") REFERENCES "public"."thread_entries"("team_id","thread_id","entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_leaf_entry_fk" FOREIGN KEY ("team_id","id","leaf_entry_id") REFERENCES "public"."thread_entries"("team_id","thread_id","entry_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_entries_parent_idx" ON "thread_entries" USING btree ("team_id","thread_id","parent_id");--> statement-breakpoint
CREATE INDEX "threads_owner_activity_idx" ON "threads" USING btree ("team_id","owner_user_id","last_activity_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "threads_project_activity_idx" ON "threads" USING btree ("team_id","project_id","last_activity_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "threads"."project_id" IS NOT NULL AND "threads"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "threads_deleted_idx" ON "threads" USING btree ("team_id","deleted_at") WHERE "threads"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_thread_idx" ON "runs" USING btree ("team_id","thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_thread" ON "runs" USING btree ("team_id","thread_id") WHERE "runs"."status" IN ('running', 'waiting_approval');--> statement-breakpoint
CREATE UNIQUE INDEX "runs_queue_pos_unique" ON "runs" USING btree ("team_id","thread_id","queue_pos") WHERE "runs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "runs_compaction_idx" ON "runs" USING btree ("team_id","ended_at") WHERE "runs"."ended_at" IS NOT NULL AND "runs"."events_compacted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "events_pending_idx" ON "events" USING btree ("team_id","created_at","id") WHERE "events"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "events_scheduled_idx" ON "events" USING btree ("team_id","due_at") WHERE "events"."status" = 'scheduled';