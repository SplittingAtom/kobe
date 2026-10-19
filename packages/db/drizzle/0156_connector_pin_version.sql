ALTER TABLE "connectors" ADD COLUMN "pin_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "templates_skipped" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_pin_version" CHECK ("connectors"."pin_version" IN (1, 2));--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_templates_skipped" CHECK ("connectors"."templates_skipped" IS NULL OR "connectors"."templates_skipped" ~ '^[a-z_]{1,32}$');