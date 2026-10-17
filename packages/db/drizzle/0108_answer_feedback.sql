CREATE TABLE "answer_feedback" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"entry_id" text,
	"user_id" uuid NOT NULL,
	"rating" text NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"comment" text,
	"agent_scope" "agent_scope",
	"agent_id" uuid,
	"agent_version" integer,
	"model_alias" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_feedback_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "answer_feedback_run_user_unique" UNIQUE("team_id","run_id","user_id"),
	CONSTRAINT "answer_feedback_rating" CHECK ("answer_feedback"."rating" IN ('up', 'down')),
	CONSTRAINT "answer_feedback_reasons" CHECK ("answer_feedback"."reasons" <@ ARRAY['wrong', 'ignored_instructions', 'unsafe', 'too_slow', 'other']::text[] AND cardinality("answer_feedback"."reasons") <= 5 AND array_position("answer_feedback"."reasons", NULL) IS NULL),
	CONSTRAINT "answer_feedback_comment" CHECK ("answer_feedback"."comment" IS NULL OR char_length("answer_feedback"."comment") BETWEEN 1 AND 500),
	CONSTRAINT "answer_feedback_down_only" CHECK ("answer_feedback"."rating" = 'down' OR (cardinality("answer_feedback"."reasons") = 0 AND "answer_feedback"."comment" IS NULL)),
	CONSTRAINT "answer_feedback_agent" CHECK (("answer_feedback"."agent_id" IS NULL) = ("answer_feedback"."agent_scope" IS NULL) AND ("answer_feedback"."agent_version" IS NULL OR ("answer_feedback"."agent_id" IS NOT NULL AND "answer_feedback"."agent_version" > 0))),
	CONSTRAINT "answer_feedback_model_alias" CHECK ("answer_feedback"."model_alias" IS NULL OR char_length("answer_feedback"."model_alias") BETWEEN 1 AND 240),
	CONSTRAINT "answer_feedback_entry_id" CHECK ("answer_feedback"."entry_id" IS NULL OR char_length("answer_feedback"."entry_id") BETWEEN 1 AND 128),
	CONSTRAINT "answer_feedback_updated_at" CHECK ("answer_feedback"."updated_at" >= "answer_feedback"."created_at")
);
--> statement-breakpoint
ALTER TABLE "answer_feedback" ADD CONSTRAINT "answer_feedback_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_feedback" ADD CONSTRAINT "answer_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_feedback" ADD CONSTRAINT "answer_feedback_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_feedback" ADD CONSTRAINT "answer_feedback_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_feedback" ADD CONSTRAINT "answer_feedback_entry_fk" FOREIGN KEY ("team_id","thread_id","entry_id") REFERENCES "public"."thread_entries"("team_id","thread_id","entry_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_feedback_thread_user_idx" ON "answer_feedback" USING btree ("team_id","thread_id","user_id");--> statement-breakpoint
CREATE INDEX "answer_feedback_agent_idx" ON "answer_feedback" USING btree ("team_id","agent_id","updated_at") WHERE "answer_feedback"."agent_id" IS NOT NULL;