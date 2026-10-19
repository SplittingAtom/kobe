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
	"pinned_by" uuid,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_ui_resources_connector_id_uri_pk" PRIMARY KEY("connector_id","uri"),
	CONSTRAINT "connector_ui_resources_uri" CHECK (char_length("connector_ui_resources"."uri") <= 2048 AND "connector_ui_resources"."uri" ~ '^ui://[^[:space:]]+$'),
	CONSTRAINT "connector_ui_resources_mime_type" CHECK ("connector_ui_resources"."mime_type" = 'text/html' || chr(59) || 'profile=mcp-app'),
	CONSTRAINT "connector_ui_resources_html" CHECK (octet_length("connector_ui_resources"."html") <= 524288),
	CONSTRAINT "connector_ui_resources_sha256" CHECK ("connector_ui_resources"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "connector_ui_resources_pinned_hash" CHECK ("connector_ui_resources"."pinned_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "connector_ui_resources_meta" CHECK (jsonb_typeof("connector_ui_resources"."meta") = 'object'),
	CONSTRAINT "connector_ui_resources_status" CHECK ("connector_ui_resources"."status" IN ('pinned', 'drifted')),
	CONSTRAINT "connector_ui_resources_proposed" CHECK ("connector_ui_resources"."proposed" IS NULL OR ("connector_ui_resources"."status" = 'drifted' AND jsonb_typeof("connector_ui_resources"."proposed") = 'object'))
);
--> statement-breakpoint
ALTER TABLE "connector_ui_resources" ADD CONSTRAINT "connector_ui_resources_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_ui_resources" ADD CONSTRAINT "connector_ui_resources_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;