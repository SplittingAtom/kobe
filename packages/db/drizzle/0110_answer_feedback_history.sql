CREATE TABLE "answer_feedback_history" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"feedback_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"entry_id" text,
	"user_id" uuid NOT NULL,
	"rating" text NOT NULL,
	"reasons" text[] NOT NULL,
	"comment" text,
	"agent_scope" "agent_scope",
	"agent_id" uuid,
	"agent_version" integer,
	"model_alias" text,
	"rated_at" timestamp with time zone NOT NULL,
	"rated_updated_at" timestamp with time zone NOT NULL,
	"change" text NOT NULL,
	"kept_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_feedback_history_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "answer_feedback_history_change" CHECK ("answer_feedback_history"."change" IN ('changed', 'cleared')),
	CONSTRAINT "answer_feedback_history_rating" CHECK ("answer_feedback_history"."rating" IN ('up', 'down'))
);
--> statement-breakpoint
ALTER TABLE "answer_feedback_history" ADD CONSTRAINT "answer_feedback_history_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_feedback_history" ADD CONSTRAINT "answer_feedback_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_feedback_history" ADD CONSTRAINT "answer_feedback_history_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_feedback_history" ADD CONSTRAINT "answer_feedback_history_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_feedback_history_thread_idx" ON "answer_feedback_history" USING btree ("team_id","thread_id");--> statement-breakpoint
CREATE INDEX "answer_feedback_history_run_idx" ON "answer_feedback_history" USING btree ("team_id","run_id","feedback_id");