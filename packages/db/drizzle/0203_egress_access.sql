ALTER TABLE "egress_domains" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "egress_requests" ADD COLUMN "scope" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "egress_requests" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "egress_requests" ADD CONSTRAINT "egress_requests_scope" CHECK ("egress_requests"."scope" IN ('team', 'site'));--> statement-breakpoint
ALTER TABLE "egress_requests" ADD CONSTRAINT "egress_requests_internal_scope" CHECK (NOT "egress_requests"."internal" OR "egress_requests"."scope" = 'site');