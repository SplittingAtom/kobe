CREATE TABLE "thread_app_results" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" uuid,
	"pi_name" text,
	"input_sha256" text,
	"tool_call_id" text,
	"prompt_entry_id" text,
	"entry_id" text,
	"connector_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"template_uri" text NOT NULL,
	"template_sha256" text NOT NULL,
	"app_id" text NOT NULL,
	"storage" text NOT NULL,
	"result" jsonb,
	"blob_ref" text,
	"bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "thread_app_results_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "thread_app_results_tool_call" UNIQUE("team_id","run_id","tool_call_id"),
	CONSTRAINT "thread_app_results_placed" UNIQUE("team_id","thread_id","prompt_entry_id","tool_call_id"),
	CONSTRAINT "thread_app_results_entry" UNIQUE("team_id","thread_id","entry_id"),
	CONSTRAINT "thread_app_results_storage" CHECK ("thread_app_results"."storage" IN ('inline', 'blob', 'too_large')),
	CONSTRAINT "thread_app_results_stored" CHECK (("thread_app_results"."storage" = 'inline') = ("thread_app_results"."result" IS NOT NULL)
        AND ("thread_app_results"."storage" = 'blob') = ("thread_app_results"."blob_ref" IS NOT NULL)),
	CONSTRAINT "thread_app_results_bytes" CHECK ("thread_app_results"."bytes" >= 0),
	CONSTRAINT "thread_app_results_inline_size" CHECK ("thread_app_results"."storage" <> 'inline' OR "thread_app_results"."bytes" <= 262144),
	CONSTRAINT "thread_app_results_origin" CHECK (NOT ("thread_app_results"."entry_id" IS NOT NULL AND "thread_app_results"."tool_call_id" IS NOT NULL)
        AND ("thread_app_results"."entry_id" IS NOT NULL OR "thread_app_results"."tool_call_id" IS NOT NULL
          OR ("thread_app_results"."run_id" IS NOT NULL AND "thread_app_results"."pi_name" IS NOT NULL AND "thread_app_results"."input_sha256" IS NOT NULL))),
	CONSTRAINT "thread_app_results_hashes" CHECK ("thread_app_results"."template_sha256" ~ '^[0-9a-f]{64}$' AND "thread_app_results"."app_id" ~ '^[0-9a-f]{64}$'
        AND ("thread_app_results"."input_sha256" IS NULL OR "thread_app_results"."input_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "thread_app_results_uri" CHECK ("thread_app_results"."template_uri" LIKE 'ui://%')
);
--> statement-breakpoint
ALTER TABLE "thread_app_results" ADD CONSTRAINT "thread_app_results_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_app_results" ADD CONSTRAINT "thread_app_results_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_app_results_thread_idx" ON "thread_app_results" USING btree ("team_id","thread_id");--> statement-breakpoint
CREATE INDEX "thread_app_results_unclaimed_idx" ON "thread_app_results" USING btree ("team_id","run_id","pi_name","input_sha256","created_at") WHERE "thread_app_results"."tool_call_id" IS NULL AND "thread_app_results"."entry_id" IS NULL;--> statement-breakpoint
CREATE INDEX "thread_app_results_blob_ref_idx" ON "thread_app_results" USING btree ("team_id","blob_ref");