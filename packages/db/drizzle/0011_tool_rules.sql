CREATE TYPE "public"."tool_rule_effect" AS ENUM('deny', 'ask', 'allow');--> statement-breakpoint
CREATE TYPE "public"."tool_rule_scope" AS ENUM('team', 'user');--> statement-breakpoint
CREATE TABLE "install_tool_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"effect" "tool_rule_effect" NOT NULL,
	"tool_glob" text NOT NULL,
	"arg_pattern" jsonb,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "install_tool_rules_effect" CHECK ("install_tool_rules"."effect" IN ('deny', 'ask')),
	CONSTRAINT "install_tool_rules_glob" CHECK (char_length("install_tool_rules"."tool_glob") BETWEEN 1 AND 256),
	CONSTRAINT "install_tool_rules_arg_pattern" CHECK ("install_tool_rules"."arg_pattern" IS NULL OR jsonb_typeof("install_tool_rules"."arg_pattern") = 'object'),
	CONSTRAINT "install_tool_rules_note" CHECK ("install_tool_rules"."note" IS NULL OR char_length("install_tool_rules"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "tool_rules" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"scope" "tool_rule_scope" NOT NULL,
	"user_id" uuid,
	"effect" "tool_rule_effect" NOT NULL,
	"tool_glob" text NOT NULL,
	"arg_pattern" jsonb,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "tool_rules_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "tool_rules_scope_ref" CHECK (("tool_rules"."scope" = 'team') = ("tool_rules"."user_id" IS NULL)),
	CONSTRAINT "tool_rules_user_effect" CHECK ("tool_rules"."scope" = 'team' OR "tool_rules"."effect" = 'allow'),
	CONSTRAINT "tool_rules_glob" CHECK (char_length("tool_rules"."tool_glob") BETWEEN 1 AND 256),
	CONSTRAINT "tool_rules_arg_pattern" CHECK ("tool_rules"."arg_pattern" IS NULL OR jsonb_typeof("tool_rules"."arg_pattern") = 'object'),
	CONSTRAINT "tool_rules_note" CHECK ("tool_rules"."note" IS NULL OR char_length("tool_rules"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "install_tool_rules" ADD CONSTRAINT "install_tool_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_rules" ADD CONSTRAINT "tool_rules_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_rules" ADD CONSTRAINT "tool_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_rules" ADD CONSTRAINT "tool_rules_member_fk" FOREIGN KEY ("team_id","user_id") REFERENCES "public"."team_members"("team_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_rules_scope_idx" ON "tool_rules" USING btree ("team_id","scope","user_id");