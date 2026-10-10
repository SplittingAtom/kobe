ALTER TABLE "connector_grants" DROP CONSTRAINT "connector_grants_kind";--> statement-breakpoint
ALTER TABLE "connector_grants" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_grants" ADD CONSTRAINT "connector_grants_kind" CHECK ("connector_grants"."kind" IN ('api_key', 'oauth'));