-- KOBE-442 (review H1, M2): a conversation saves into one draft per skill name. Custom, so
-- db:rebase keeps this SQL as written; it runs after 0149 added `synced_rev` (nullable) and before
-- 0151 makes (team, author, conversation, name) unique among the drafts a conversation saves into.
--
-- Each existing draft started from a conversation becomes that conversation's save target at its
-- current revision, so Save to Workbench keeps updating it as before. Where earlier races left
-- more than one draft of a name for a conversation (KOBE-322 review N2), only the most recently
-- updated one does; the others keep their files and provenance and are no longer saved into.
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS) and `skill_drafts` has FORCE ROW
-- LEVEL SECURITY with no `kobe.team_id` set, so FORCE is lifted for the backfill only (one
-- transaction; ALTER TABLE holds its lock until commit, so nothing else sees the table without it).
-- (skill-drafts-synced-rev-upgrade.db.test.ts migrates a database with such rows.)
ALTER TABLE "skill_drafts" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "skill_drafts" AS d
   SET "synced_rev" = d."rev"
  FROM (
    SELECT "team_id", "id",
           row_number() OVER (
             PARTITION BY "team_id", "owner_user_id", "from_thread_id", "name"
             ORDER BY "updated_at" DESC, "id"
           ) AS n
      FROM "skill_drafts"
     WHERE "from_thread_id" IS NOT NULL
  ) AS ranked
 WHERE ranked."team_id" = d."team_id" AND ranked."id" = d."id" AND ranked.n = 1;--> statement-breakpoint
ALTER TABLE "skill_drafts" FORCE ROW LEVEL SECURITY;
