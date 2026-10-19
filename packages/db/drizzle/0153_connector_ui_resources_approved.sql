ALTER TABLE "connector_ui_resources" DROP CONSTRAINT "connector_ui_resources_uri";--> statement-breakpoint
ALTER TABLE "connector_ui_resources" DROP CONSTRAINT "connector_ui_resources_meta";--> statement-breakpoint
ALTER TABLE "connector_ui_resources" ADD COLUMN "approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_ui_resources" ADD CONSTRAINT "connector_ui_resources_uri" CHECK (char_length("connector_ui_resources"."uri") <= 2048 AND "connector_ui_resources"."uri" ~ '^ui://[!-~]+$');--> statement-breakpoint
ALTER TABLE "connector_ui_resources" ADD CONSTRAINT "connector_ui_resources_meta" CHECK (jsonb_typeof("connector_ui_resources"."meta") = 'object' AND octet_length("connector_ui_resources"."meta"::text) <= 16384);