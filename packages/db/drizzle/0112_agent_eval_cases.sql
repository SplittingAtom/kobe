CREATE TABLE "agent_eval_case_history" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"feedback_id" uuid,
	"user_id" uuid NOT NULL,
	"agent_scope" "agent_scope" NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version" integer,
	"content" jsonb NOT NULL,
	"status" text NOT NULL,
	"expected_behaviour" text,
	"reviewed_at" timestamp with time zone,
	"shared_at" timestamp with time zone NOT NULL,
	"kept_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_eval_case_history_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "agent_eval_case_history_status" CHECK ("agent_eval_case_history"."status" IN ('open', 'accepted', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "agent_eval_cases" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"feedback_id" uuid,
	"user_id" uuid NOT NULL,
	"agent_scope" "agent_scope" NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version" integer,
	"content" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"expected_behaviour" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_eval_cases_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "agent_eval_cases_feedback_unique" UNIQUE("team_id","feedback_id"),
	CONSTRAINT "agent_eval_cases_scope" CHECK ("agent_eval_cases"."agent_scope" IN ('team', 'personal')),
	CONSTRAINT "agent_eval_cases_status" CHECK ("agent_eval_cases"."status" IN ('open', 'accepted', 'dismissed')),
	CONSTRAINT "agent_eval_cases_version" CHECK ("agent_eval_cases"."agent_version" IS NULL OR "agent_eval_cases"."agent_version" > 0),
	CONSTRAINT "agent_eval_cases_content" CHECK (jsonb_typeof("agent_eval_cases"."content") = 'object' AND octet_length("agent_eval_cases"."content"::text) <= 131072),
	CONSTRAINT "agent_eval_cases_expected" CHECK ("agent_eval_cases"."expected_behaviour" IS NULL OR char_length("agent_eval_cases"."expected_behaviour") BETWEEN 1 AND 2000),
	CONSTRAINT "agent_eval_cases_accepted" CHECK ("agent_eval_cases"."status" <> 'accepted' OR "agent_eval_cases"."expected_behaviour" IS NOT NULL),
	CONSTRAINT "agent_eval_cases_reviewed" CHECK ("agent_eval_cases"."status" = 'open' OR "agent_eval_cases"."reviewed_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "orbit_evals" ADD COLUMN "case_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "orbit_evals" ADD COLUMN "case_scored" integer;--> statement-breakpoint
ALTER TABLE "orbit_evals" ADD COLUMN "case_failures" integer;--> statement-breakpoint
ALTER TABLE "agent_eval_case_history" ADD CONSTRAINT "agent_eval_case_history_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_case_history" ADD CONSTRAINT "agent_eval_case_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_cases" ADD CONSTRAINT "agent_eval_cases_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_eval_cases" ADD CONSTRAINT "agent_eval_cases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_eval_case_history_user_idx" ON "agent_eval_case_history" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE INDEX "agent_eval_cases_agent_idx" ON "agent_eval_cases" USING btree ("team_id","agent_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_eval_cases_user_idx" ON "agent_eval_cases" USING btree ("team_id","user_id","created_at");