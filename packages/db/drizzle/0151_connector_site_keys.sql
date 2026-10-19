CREATE TABLE "connector_site_keys" (
	"connector_id" uuid PRIMARY KEY NOT NULL,
	"sealed" text NOT NULL,
	"key_id" text NOT NULL,
	"url_sha256" text NOT NULL,
	"hint" text NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_site_keys_sealed" CHECK ("connector_site_keys"."sealed" ~ '^e1\.[A-Za-z0-9_.-]+$' AND char_length("connector_site_keys"."sealed") <= 16384),
	CONSTRAINT "connector_site_keys_url_sha256" CHECK ("connector_site_keys"."url_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "connector_site_keys_key_id" CHECK (char_length("connector_site_keys"."key_id") BETWEEN 1 AND 64),
	CONSTRAINT "connector_site_keys_hint" CHECK (char_length("connector_site_keys"."hint") <= 16)
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "credential_source" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_site_keys" ADD CONSTRAINT "connector_site_keys_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_site_keys" ADD CONSTRAINT "connector_site_keys_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_credential_source" CHECK ("connectors"."credential_source" IN ('member', 'site'));--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_site_key_api_key" CHECK ("connectors"."credential_source" = 'member' OR "connectors"."auth_kind" = 'api_key');