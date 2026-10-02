CREATE TYPE "public"."sandbox_command_status" AS ENUM('pending', 'delivered', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "sandbox_commands" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" uuid,
	"kind" text NOT NULL,
	"frame" jsonb NOT NULL,
	"status" "sandbox_command_status" DEFAULT 'pending' NOT NULL,
	"connection_id" uuid,
	"requester_replica" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sandbox_commands_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "sandbox_commands_kind" CHECK ("sandbox_commands"."kind" IN ('run.start', 'run.steer', 'run.stop', 'pi.command')),
	CONSTRAINT "sandbox_commands_requester" CHECK (char_length("sandbox_commands"."requester_replica") BETWEEN 1 AND 64),
	CONSTRAINT "sandbox_commands_frame_object" CHECK (jsonb_typeof("sandbox_commands"."frame") = 'object'),
	CONSTRAINT "sandbox_commands_delivered" CHECK ("sandbox_commands"."status" = 'pending' OR "sandbox_commands"."status" = 'failed' OR "sandbox_commands"."connection_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "sandbox_connections" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"replica_id" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "sandbox_connections_team_id_user_id_pk" PRIMARY KEY("team_id","user_id"),
	CONSTRAINT "sandbox_connections_replica_id" CHECK (char_length("sandbox_connections"."replica_id") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "sandbox_run_leases" (
	"team_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"leased_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_run_leases_team_id_run_id_pk" PRIMARY KEY("team_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "sandbox_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_commands" ADD CONSTRAINT "sandbox_commands_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_commands" ADD CONSTRAINT "sandbox_commands_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_connections" ADD CONSTRAINT "sandbox_connections_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_connections" ADD CONSTRAINT "sandbox_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_run_leases" ADD CONSTRAINT "sandbox_run_leases_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_run_leases" ADD CONSTRAINT "sandbox_run_leases_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_run_leases" ADD CONSTRAINT "sandbox_run_leases_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_commands_open_idx" ON "sandbox_commands" USING btree ("team_id","user_id","created_at") WHERE "sandbox_commands"."status" IN ('pending', 'delivered');--> statement-breakpoint
CREATE INDEX "sandbox_commands_expiry_idx" ON "sandbox_commands" USING btree ("team_id","expires_at");--> statement-breakpoint
CREATE INDEX "sandbox_run_leases_user_idx" ON "sandbox_run_leases" USING btree ("team_id","user_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_sandbox_seq" CHECK ("runs"."sandbox_seq" >= 0);