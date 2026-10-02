CREATE TYPE "public"."audit_actor_kind" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"seq" bigint PRIMARY KEY DEFAULT 0 NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid,
	"actor_kind" "audit_actor_kind" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"prev_hash" text DEFAULT '' NOT NULL,
	"hash" text DEFAULT '' NOT NULL,
	CONSTRAINT "audit_log_id_unique" UNIQUE("id"),
	CONSTRAINT "audit_log_action_format" CHECK ("audit_log"."action" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*){1,3}$'),
	CONSTRAINT "audit_log_action_length" CHECK (char_length("audit_log"."action") <= 64),
	CONSTRAINT "audit_log_target_object" CHECK (jsonb_typeof("audit_log"."target") = 'object'),
	CONSTRAINT "audit_log_target_size" CHECK (octet_length("audit_log"."target"::text) <= 4096),
	CONSTRAINT "audit_log_user_agent_length" CHECK (char_length("audit_log"."user_agent") <= 256),
	CONSTRAINT "audit_log_system_actor" CHECK ("audit_log"."actor_kind" <> 'system' OR "audit_log"."actor_id" IS NULL)
);
--> statement-breakpoint
CREATE INDEX "audit_log_team_seq_idx" ON "audit_log" USING btree ("team_id","seq") WHERE "audit_log"."team_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_log_actor_seq_idx" ON "audit_log" USING btree ("actor_id","seq");--> statement-breakpoint
CREATE INDEX "audit_log_action_seq_idx" ON "audit_log" USING btree ("action","seq");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");