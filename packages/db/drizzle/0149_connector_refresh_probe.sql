ALTER TABLE "connectors" ADD COLUMN "pinned_by" uuid;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "refresh_skipped" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_refresh_skipped" CHECK ("connectors"."refresh_skipped" IS NULL OR "connectors"."refresh_skipped" ~ '^[a-z_]{1,32}$');