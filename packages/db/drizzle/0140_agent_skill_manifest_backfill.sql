-- KOBE-318 (Skills v1.2, SK28): agent publish freezes local skill versions. Custom, so db:rebase
-- keeps this SQL as written; it runs after 0139_agent_skill_manifest added the column (nullable,
-- so it could be added to existing rows).
--
-- Every existing team agent version is frozen at the local skill versions it resolves to today,
-- exactly as run start resolves a named skill (server `runs/resolver-input.ts`, `loadSkillFacts`):
--   * names in the agent's order, once each, from `skills` (a list) or `skills.exclusive`;
--   * Kobe's seven names never (they resolve through the catalog, KOBE-317);
--   * a name the team has a skill of (`team_skills.slug`, archived ones too), at that name's
--     newest version that is approved or suspended (`teamSkillStates`: a suspended newest
--     version keeps its `suspended` notice, never an older version in its place);
--   * except a name whose own skill is archived while the team installed a published catalog
--     skill of that name (the name-clash rule hands the name to the install, `catalogNamed`).
-- A version with no reviewed version (pending, rejected) is not frozen: it stays `not_approved`.
-- Personal and gallery versions (`site_agent_versions`) have no team, so nothing to freeze.
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS). The team tables read and written
-- here have FORCE ROW LEVEL SECURITY and no `kobe.team_id` is set, so the owner would see no rows:
-- FORCE is lifted for the backfill only (one transaction; ALTER TABLE holds its lock until it
-- commits, so nothing else sees the tables without it). The versions' immutability trigger refuses
-- every UPDATE, so it is disabled for the backfill only, likewise.
-- (agent-skill-manifest-upgrade.db.test.ts migrates a database with rows this way; the server's
-- skill-freeze-upgrade.db.test.ts checks run-start resolution is the same before and after.)
ALTER TABLE "team_agent_versions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skills" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_installs" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_agent_versions" DISABLE TRIGGER "team_agent_versions_immutable";--> statement-breakpoint
UPDATE "team_agent_versions" AS v
   SET "skill_manifest" = jsonb_build_object('skills', COALESCE((
     SELECT jsonb_agg(
              jsonb_build_object('name', n.name, 'skill_id', r.skill_id, 'version', r.version)
              ORDER BY n.ord)
       FROM (
         SELECT DISTINCT ON (e.name) e.name, e.ord
           FROM jsonb_array_elements_text(
                  CASE
                    WHEN jsonb_typeof(v.frontmatter -> 'skills') = 'array'
                      THEN v.frontmatter -> 'skills'
                    WHEN jsonb_typeof(v.frontmatter -> 'skills' -> 'exclusive') = 'array'
                      THEN v.frontmatter -> 'skills' -> 'exclusive'
                    ELSE '[]'::jsonb
                  END) WITH ORDINALITY AS e(name, ord)
          ORDER BY e.name, e.ord
       ) AS n
       -- Through the team's skill of that name (unique (team_id, slug)), then its review rows by
       -- primary key, newest first: a name the team has no skill of has none. Same rows as
       -- reviews by slug alone (`teamSkillStates`), without scanning every review row of the team.
       CROSS JOIN LATERAL (
         SELECT tr.skill_id, tr.version
           FROM "team_skills" ts
           JOIN "team_skill_reviews" tr ON tr.team_id = ts.team_id AND tr.skill_id = ts.id
          WHERE ts.team_id = v.team_id AND ts.slug = n.name
            AND tr.scope = 'team' AND tr.slug = n.name
            AND (tr.status = 'approved' OR tr.suspended_at IS NOT NULL)
          ORDER BY tr.version DESC
          LIMIT 1
       ) AS r
      WHERE n.name NOT IN ('data-analysis', 'charts', 'docx', 'pdf', 'xlsx', 'code-review',
                           'skill-creator')
        AND NOT (
          EXISTS (
            SELECT 1 FROM "team_skills" s
             WHERE s.team_id = v.team_id AND s.slug = n.name AND s.archived_at IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM "team_skill_installs" i
              JOIN "registry_skills" rs ON rs.id = i.skill_id
             WHERE i.team_id = v.team_id AND rs.name = n.name)
          AND EXISTS (
            SELECT 1 FROM "registry_skills" rs
              JOIN "registry_versions" rv ON rv.skill_id = rs.id
             WHERE rs.name = n.name
               AND rv.state::text IN ('approved', 'deprecated', 'withdrawn', 'revoked'))
        )
   ), '[]'::jsonb))
 WHERE "skill_manifest" IS NULL;--> statement-breakpoint
-- Counted while FORCE is lifted (under FORCE the owner sees no team rows).
DO $$
DECLARE
  versions bigint;
  frozen bigint;
BEGIN
  SELECT count(*), coalesce(sum(jsonb_array_length("skill_manifest" -> 'skills')), 0)
    FROM "team_agent_versions" INTO versions, frozen;
  RAISE NOTICE 'kobe: % team agent versions frozen at % local skill versions', versions, frozen;
END $$;--> statement-breakpoint
ALTER TABLE "team_agent_versions" ENABLE TRIGGER "team_agent_versions_immutable";--> statement-breakpoint
ALTER TABLE "team_skill_installs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skills" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_agent_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- From here on every team agent version carries its manifest (the server writes it at publish
-- and validates entries on read): an object with a `skills` array, bounded like the tool manifest.
ALTER TABLE "team_agent_versions" ADD CONSTRAINT "team_agent_versions_skill_manifest" CHECK (
  "skill_manifest" IS NOT NULL
  AND jsonb_typeof("skill_manifest") = 'object'
  AND coalesce(jsonb_typeof("skill_manifest" -> 'skills') = 'array', false)
  AND octet_length("skill_manifest"::text) <= 16384
);
