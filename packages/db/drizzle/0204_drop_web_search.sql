ALTER TABLE "team_web_search" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "web_search_settings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "team_web_search" CASCADE;--> statement-breakpoint
DROP TABLE "web_search_settings" CASCADE;--> statement-breakpoint
ALTER TABLE "egress_domains" DROP CONSTRAINT "egress_domains_preset";--> statement-breakpoint
ALTER TABLE "egress_domains" ADD CONSTRAINT "egress_domains_preset" CHECK ("egress_domains"."preset" IS NULL OR "egress_domains"."preset" IN ('package_registries', 'git_hosts'));