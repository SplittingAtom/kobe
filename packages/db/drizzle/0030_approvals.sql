CREATE TYPE "public"."approval_status" AS ENUM('pending', 'allowed', 'denied', 'expired');--> statement-breakpoint
CREATE TABLE "approvals" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool" text NOT NULL,
	"input_canonical" text NOT NULL,
	"risk" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"cause" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token_kid" text,
	"token_expires_at" timestamp (3) with time zone,
	"input_hmac" text,
	"consumed_at" timestamp with time zone,
	"remembered" boolean DEFAULT false NOT NULL,
	CONSTRAINT "approvals_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "approvals_tool_call_key" UNIQUE("team_id","run_id","tool_call_id"),
	CONSTRAINT "approvals_tool_call_id" CHECK (char_length("approvals"."tool_call_id") BETWEEN 1 AND 128),
	CONSTRAINT "approvals_tool" CHECK (char_length("approvals"."tool") BETWEEN 1 AND 256),
	CONSTRAINT "approvals_input" CHECK (octet_length("approvals"."input_canonical") <= 262144),
	CONSTRAINT "approvals_risk" CHECK ("approvals"."risk" IN ('read', 'write', 'destructive')),
	CONSTRAINT "approvals_reasons" CHECK (jsonb_typeof("approvals"."reasons") = 'array'),
	CONSTRAINT "approvals_cause" CHECK ("approvals"."cause" IS NULL OR "approvals"."cause" IN ('user', 'ttl', 'run_cancelled', 'run_interrupted', 'budget_exhausted', 'run_failed')),
	CONSTRAINT "approvals_decided" CHECK (("approvals"."status" = 'pending') = ("approvals"."decided_at" IS NULL AND "approvals"."cause" IS NULL)),
	CONSTRAINT "approvals_decided_by" CHECK (("approvals"."status" IN ('allowed', 'denied')) = ("approvals"."decided_by" IS NOT NULL)),
	CONSTRAINT "approvals_token" CHECK (("approvals"."status" = 'allowed') = ("approvals"."input_hmac" IS NOT NULL AND "approvals"."token_kid" IS NOT NULL AND "approvals"."token_expires_at" IS NOT NULL)),
	CONSTRAINT "approvals_consumed" CHECK ("approvals"."consumed_at" IS NULL OR "approvals"."status" = 'allowed'),
	CONSTRAINT "approvals_mac" CHECK ("approvals"."input_hmac" IS NULL OR "approvals"."input_hmac" ~ '^[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_pending_idx" ON "approvals" USING btree ("team_id","expires_at") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approvals_user_idx" ON "approvals" USING btree ("team_id","user_id","created_at");