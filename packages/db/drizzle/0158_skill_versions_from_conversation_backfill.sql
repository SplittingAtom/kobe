-- KOBE-333 review C4-M3: backfill `from_conversation` (0157) for versions saved before it, from
-- the audit log (never rewritten): a version is from a conversation when its `skill.uploaded` row
-- names a draft whose `skill.draft.created` row (in the version's own team, for a team version)
-- says it started from a thread or names one, and,
-- for personal versions, when a `skill.draft.personalized` row of the same skill and semver says
-- so (in any team). Versions saved from a fork of such a version before this release are not
-- traced through the fork (new saves are: the server sets the flag from the fork's parent).
-- Custom, so db:rebase keeps this SQL as written.
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS): team_skill_versions has FORCE
-- ROW LEVEL SECURITY and no `kobe.team_id` is set, so FORCE is lifted for the backfill only, and
-- the versions' immutability triggers are disabled for it, as in 0130 (one transaction; ALTER
-- TABLE holds its lock until commit, so nothing else sees the tables without them).
ALTER TABLE "team_skill_versions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_versions" DISABLE TRIGGER "team_skill_versions_immutable";--> statement-breakpoint
ALTER TABLE "personal_skill_versions" DISABLE TRIGGER "personal_skill_versions_immutable";--> statement-breakpoint
UPDATE "team_skill_versions" AS v SET "from_conversation" = true
  FROM "audit_log" u JOIN "audit_log" d
    ON d."action" = 'skill.draft.created' AND d."team_id" = u."team_id"
   AND d."target" ->> 'draftId' = u."target" ->> 'draftId'
 WHERE u."action" = 'skill.uploaded' AND u."team_id" = v."team_id"
   AND u."target" ->> 'scope' = 'team'
   AND u."target" ->> 'skillId' = v."skill_id"::text
   AND u."target" ->> 'version' = v."version"::text
   AND (d."target" ->> 'startedFrom' = 'thread' OR d."target" ? 'fromThreadId');--> statement-breakpoint
UPDATE "personal_skill_versions" AS v SET "from_conversation" = true
 WHERE EXISTS (
     SELECT 1 FROM "audit_log" u JOIN "audit_log" d
       ON d."action" = 'skill.draft.created' AND d."target" ->> 'draftId' = u."target" ->> 'draftId'
      WHERE u."action" = 'skill.uploaded' AND u."target" ->> 'scope' = 'personal'
        AND u."target" ->> 'skillId' = v."skill_id"::text
        AND u."target" ->> 'version' = v."version"::text
        AND (d."target" ->> 'startedFrom' = 'thread' OR d."target" ? 'fromThreadId'))
    OR EXISTS (
     SELECT 1 FROM "audit_log" p
      WHERE p."action" = 'skill.draft.personalized'
        AND p."target" ->> 'skillId' = v."skill_id"::text
        AND p."target" ->> 'semver' = v."semver"
        AND (p."target" ->> 'fromConversation')::boolean);--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ENABLE TRIGGER "personal_skill_versions_immutable";--> statement-breakpoint
ALTER TABLE "team_skill_versions" ENABLE TRIGGER "team_skill_versions_immutable";--> statement-breakpoint
ALTER TABLE "team_skill_versions" FORCE ROW LEVEL SECURITY;
