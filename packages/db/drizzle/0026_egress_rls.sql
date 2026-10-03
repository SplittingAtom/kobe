-- Team isolation for team egress enablement (spec D5, D28): ENABLE + FORCE RLS and the canonical
-- policy, as in 0001_team_rls.sql. egress_domains is install-wide (the egress ceiling).
ALTER TABLE "team_egress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_egress" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_egress"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
-- Presets (D28). Fresh installs reach nothing: package registries sit in the ceiling but no team
-- has them enabled; git hosts are listed for install admins to add to the ceiling in one step.
-- The web-search provider's domain is added by KOBE-63 when a provider is configured.
INSERT INTO "egress_domains" ("domain", "preset", "in_ceiling") VALUES
  ('pypi.org', 'package_registries', true),
  ('files.pythonhosted.org', 'package_registries', true),
  ('registry.npmjs.org', 'package_registries', true),
  ('deb.debian.org', 'package_registries', true),
  ('github.com', 'git_hosts', false),
  ('gitlab.com', 'git_hosts', false)
ON CONFLICT ("domain") DO NOTHING;
