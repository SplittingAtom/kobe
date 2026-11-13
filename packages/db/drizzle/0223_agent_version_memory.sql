ALTER TABLE "site_agent_versions" ADD COLUMN "memory" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_agent_versions" ADD COLUMN "memory" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_agent_versions" ADD CONSTRAINT "site_agent_versions_memory" CHECK ("site_agent_versions"."memory" IN ('all', 'notes_only', 'off'));--> statement-breakpoint
ALTER TABLE "team_agent_versions" ADD CONSTRAINT "team_agent_versions_memory" CHECK ("team_agent_versions"."memory" IN ('all', 'notes_only', 'off'));