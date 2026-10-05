ALTER TABLE "connectors" ADD COLUMN "icon_url" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_icon_url" CHECK ("connectors"."icon_url" IS NULL OR (char_length("connectors"."icon_url") <= 2048 AND "connectors"."icon_url" ~ '^https://[^[:space:]]+$'));