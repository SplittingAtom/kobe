CREATE TABLE "connector_ui_resources" (
	"connector_id" uuid NOT NULL,
	"uri" text NOT NULL,
	"mime_type" text NOT NULL,
	"html" text NOT NULL,
	"sha256" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pinned_hash" text NOT NULL,
	"status" text DEFAULT 'pinned' NOT NULL,
	"proposed" jsonb,
	"approved" boolean DEFAULT false NOT NULL,
	"pinned_by" uuid,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_ui_resources_connector_id_uri_pk" PRIMARY KEY("connector_id","uri"),
	CONSTRAINT "connector_ui_resources_uri" CHECK (char_length("connector_ui_resources"."uri") <= 2048 AND "connector_ui_resources"."uri" ~ '^ui://[!-~]+$'),
	CONSTRAINT "connector_ui_resources_mime_type" CHECK ("connector_ui_resources"."mime_type" = 'text/html' || chr(59) || 'profile=mcp-app'),
	CONSTRAINT "connector_ui_resources_html" CHECK (octet_length("connector_ui_resources"."html") <= 524288),
	CONSTRAINT "connector_ui_resources_sha256" CHECK ("connector_ui_resources"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "connector_ui_resources_pinned_hash" CHECK ("connector_ui_resources"."pinned_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "connector_ui_resources_meta" CHECK (jsonb_typeof("connector_ui_resources"."meta") = 'object' AND octet_length("connector_ui_resources"."meta"::text) <= 16384),
	CONSTRAINT "connector_ui_resources_status" CHECK ("connector_ui_resources"."status" IN ('pinned', 'drifted')),
	CONSTRAINT "connector_ui_resources_approved" CHECK ("connector_ui_resources"."approved" OR "connector_ui_resources"."status" = 'drifted'),
	CONSTRAINT "connector_ui_resources_proposed" CHECK ("connector_ui_resources"."proposed" IS NULL OR ("connector_ui_resources"."status" = 'drifted' AND jsonb_typeof("connector_ui_resources"."proposed") = 'object'))
);
--> statement-breakpoint
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
	"input" jsonb,
	"storage" text NOT NULL,
	"result" jsonb,
	"blob_ref" text,
	"bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"opened_by" uuid,
	"card_text" text,
	"queued_at" timestamp with time zone,
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
	CONSTRAINT "thread_app_results_uri" CHECK ("thread_app_results"."template_uri" LIKE 'ui://%'),
	CONSTRAINT "thread_app_results_input_size" CHECK ("thread_app_results"."input" IS NULL OR octet_length("thread_app_results"."input"::text) <= 65536),
	CONSTRAINT "thread_app_results_queued" CHECK (("thread_app_results"."queued_at" IS NULL OR ("thread_app_results"."entry_id" IS NOT NULL AND "thread_app_results"."card_text" IS NOT NULL))
        AND ("thread_app_results"."card_text" IS NULL OR char_length("thread_app_results"."card_text") <= 16384)
        AND ("thread_app_results"."opened_by" IS NULL OR "thread_app_results"."entry_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "pin_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "templates_skipped" text;--> statement-breakpoint
ALTER TABLE "connector_ui_resources" ADD CONSTRAINT "connector_ui_resources_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_ui_resources" ADD CONSTRAINT "connector_ui_resources_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_app_results" ADD CONSTRAINT "thread_app_results_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_app_results" ADD CONSTRAINT "thread_app_results_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_app_results" ADD CONSTRAINT "thread_app_results_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_app_results_thread_idx" ON "thread_app_results" USING btree ("team_id","thread_id");--> statement-breakpoint
CREATE INDEX "thread_app_results_unclaimed_idx" ON "thread_app_results" USING btree ("team_id","run_id","pi_name","input_sha256","created_at") WHERE "thread_app_results"."tool_call_id" IS NULL AND "thread_app_results"."entry_id" IS NULL;--> statement-breakpoint
CREATE INDEX "thread_app_results_blob_ref_idx" ON "thread_app_results" USING btree ("team_id","blob_ref");--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_pin_version" CHECK ("connectors"."pin_version" IN (1, 2));--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_templates_skipped" CHECK ("connectors"."templates_skipped" IS NULL OR "connectors"."templates_skipped" ~ '^[a-z_]{1,32}$');