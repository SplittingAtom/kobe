ALTER TABLE "install_agent_versions" ALTER COLUMN "published_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "install_agents" ADD COLUMN "gallery_key" text;--> statement-breakpoint
ALTER TABLE "install_agents" ADD COLUMN "gallery_generation" integer;--> statement-breakpoint
ALTER TABLE "install_agents" ADD COLUMN "forked_from_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "install_agents" ADD COLUMN "forked_from_version" integer;--> statement-breakpoint
ALTER TABLE "team_agents" ADD COLUMN "forked_from_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "team_agents" ADD COLUMN "forked_from_version" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "install_agents_gallery_key_unique" ON "install_agents" USING btree ("gallery_key") WHERE "install_agents"."gallery_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "install_agents" ADD CONSTRAINT "install_agents_gallery_generation" CHECK ("install_agents"."gallery_generation" IS NULL OR "install_agents"."gallery_generation" > 0);--> statement-breakpoint
ALTER TABLE "install_agents" ADD CONSTRAINT "install_agents_gallery_key_scope" CHECK ("install_agents"."gallery_key" IS NULL OR "install_agents"."scope" = 'gallery');--> statement-breakpoint
ALTER TABLE "install_agents" ADD CONSTRAINT "install_agents_fork_version" CHECK ("install_agents"."forked_from_version" IS NULL OR ("install_agents"."forked_from_agent_id" IS NOT NULL AND "install_agents"."forked_from_version" > 0));--> statement-breakpoint
ALTER TABLE "team_agents" ADD CONSTRAINT "team_agents_fork_version" CHECK ("team_agents"."forked_from_version" IS NULL OR ("team_agents"."forked_from_agent_id" IS NOT NULL AND "team_agents"."forked_from_version" > 0));