-- Backfill (KOBE-80): every existing team skill version gets a pending, unscanned review row so
-- admins approve instead of asking for re-uploads; the review queue scans them when first listed.
-- Runs before RLS is enabled below (FORCE RLS would otherwise apply to the migration role).
-- Idempotent: rows that exist are left alone.
INSERT INTO "team_skill_reviews" ("team_id", "skill_id", "version", "scope", "slug", "content_hash",
  "unscanned", "flagged", "findings", "scripts", "skipped")
SELECT v."team_id", v."skill_id", v."version", 'team', s."slug", v."content_hash", true, false,
  '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
FROM "team_skill_versions" v
JOIN "team_skills" s ON s."team_id" = v."team_id" AND s."id" = v."skill_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Team isolation for skill review state and team skill switches (KOBE-80): ENABLE + FORCE RLS and
-- the canonical policy, as in 0001_team_rls.sql.
ALTER TABLE "team_skill_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_skill_reviews"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "team_skill_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_skill_settings"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
