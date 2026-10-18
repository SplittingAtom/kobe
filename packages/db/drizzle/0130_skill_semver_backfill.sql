-- KOBE-308 (Skills v1.2, SK14): semver and sequence on skill versions, access on team skills.
-- Custom, so db:rebase keeps this SQL as written; it runs after 0129_skill_semver added the
-- columns (nullable, so they could be added to existing rows).
--
-- Every existing version n becomes semver "0.n.0" with seq n; team skills offered to all agents
-- (KOBE-297) get access `default_on`, the rest keep the default `available`.
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS). team_skills and
-- team_skill_versions have FORCE ROW LEVEL SECURITY and no `kobe.team_id` is set, so an UPDATE
-- alone would see no rows and the checks below would then fail on every existing version. FORCE
-- is lifted for the backfill only: the migration is one transaction and ALTER TABLE holds its lock
-- until it commits, so nothing else sees the tables without it. The versions' immutability
-- triggers refuse every UPDATE, so they are disabled for the backfill only, likewise.
-- (skill-semver-upgrade.db.test.ts migrates a database with rows this way.)
ALTER TABLE "team_skills" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_versions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_versions" DISABLE TRIGGER "team_skill_versions_immutable";--> statement-breakpoint
ALTER TABLE "personal_skill_versions" DISABLE TRIGGER "personal_skill_versions_immutable";--> statement-breakpoint
UPDATE "team_skill_versions"
   SET "semver" = '0.' || "version" || '.0', "seq" = "version"
 WHERE "semver" IS NULL OR "seq" IS NULL;--> statement-breakpoint
UPDATE "personal_skill_versions"
   SET "semver" = '0.' || "version" || '.0', "seq" = "version"
 WHERE "semver" IS NULL OR "seq" IS NULL;--> statement-breakpoint
UPDATE "team_skills" SET "access" = 'default_on' WHERE "offer_to_all";--> statement-breakpoint
-- Counted while FORCE is lifted (under FORCE the owner sees no team rows).
DO $$
DECLARE
  versions bigint;
  offered bigint;
BEGIN
  SELECT (SELECT count(*) FROM "team_skill_versions") + (SELECT count(*) FROM "personal_skill_versions")
    INTO versions;
  SELECT count(*) FROM "team_skills" WHERE "access" = 'default_on' INTO offered;
  RAISE NOTICE 'kobe: % skill versions numbered 0.<n>.0; % team skills set to access default_on',
    versions, offered;
END $$;--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ENABLE TRIGGER "personal_skill_versions_immutable";--> statement-breakpoint
ALTER TABLE "team_skill_versions" ENABLE TRIGGER "team_skill_versions_immutable";--> statement-breakpoint
ALTER TABLE "team_skill_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skills" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- From here on every version has a semver (MAJOR.MINOR.PATCH, each part at most 9 digits) and a
-- seq equal to its version number. The server refuses a semver not above the latest one's.
ALTER TABLE "team_skill_versions" ADD CONSTRAINT "team_skill_versions_semver_format" CHECK (
  "semver" IS NOT NULL
  AND "semver" ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
);--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD CONSTRAINT "team_skill_versions_seq_matches" CHECK (
  "seq" IS NOT NULL AND "seq" = "version"
);--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ADD CONSTRAINT "personal_skill_versions_semver_format" CHECK (
  "semver" IS NOT NULL
  AND "semver" ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$'
);--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ADD CONSTRAINT "personal_skill_versions_seq_matches" CHECK (
  "seq" IS NOT NULL AND "seq" = "version"
);
