-- KOBE-416: the review-row backfill 0056 meant to do (KOBE-80). Custom, so db:rebase keeps this
-- SQL as written. 0056 read team_skill_versions and team_skills, which have FORCE ROW LEVEL
-- SECURITY since 0051, as the owner role with no `kobe.team_id` set, so on an upgrade it saw no
-- rows and inserted nothing: team skill versions uploaded before 0056 have no review row, so they
-- are neither usable (that needs an `approved` row) nor in the review queue to approve.
--
-- Every team skill version without a review row gets a pending, unscanned one (the queue scans it
-- when first listed), exactly as 0056 intended. Since 0056 the server makes the review row in the
-- version's own transaction, so only pre-0056 versions lack one; a row that exists (made since,
-- or decided by an admin) is left as it is (ON CONFLICT DO NOTHING on the primary key).
-- Idempotent: a second run finds nothing to insert.
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS), so FORCE is lifted for the
-- backfill only (one transaction; ALTER TABLE holds its lock until commit, so nothing else sees
-- the tables without it). (skill-reviews-backfill-upgrade.db.test.ts migrates a database with
-- such versions.)
ALTER TABLE "team_skills" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_versions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "team_skill_reviews" ("team_id", "skill_id", "version", "scope", "slug", "content_hash",
  "status", "unscanned", "flagged", "findings", "scripts", "skipped")
SELECT v."team_id", v."skill_id", v."version", 'team', s."slug", v."content_hash", 'pending', true,
  false, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
  FROM "team_skill_versions" v
  JOIN "team_skills" s ON s."team_id" = v."team_id" AND s."id" = v."skill_id"
 WHERE NOT EXISTS (
   SELECT 1 FROM "team_skill_reviews" r
    WHERE r."team_id" = v."team_id" AND r."skill_id" = v."skill_id" AND r."version" = v."version")
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skills" FORCE ROW LEVEL SECURITY;
