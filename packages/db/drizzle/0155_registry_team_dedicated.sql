-- KOBE-330 review H1 (coordinator decision): the Registry team is always a dedicated team that
-- Kobe creates for the Registry (`teams.registry`, 0152); an existing team can never be named.
-- Otherwise a Site admin could name an ordinary team, give themselves the Skill reviewer grant
-- and join it without break-glass. Custom, so db:rebase keeps this SQL as written.
--
-- 1. An existing designation of an ordinary team is refused: it is cleared, so the Registry reads
--    "not ready" until a Site admin creates the Registry team in the console. Nothing else of
--    that team changes (its members, Skill reviewers among them, stay; KOBE-331 recorded no
--    grant-added memberships before `team_members.added_via`). The cleared team is reported as a
--    NOTICE in the migration log. No release had shipped KOBE-330 when this was written.
-- 2. `site_skill_settings.registry_team_id` may only name a registry team (trigger), and a team's
--    `registry` flag is fixed at creation (trigger), so neither rule can be undone by an UPDATE.
-- (registry-team-upgrade.db.test.ts migrates a database with an ordinary team named.)
DO $$
DECLARE
  cleared uuid;
BEGIN
  SELECT s."registry_team_id" INTO cleared FROM "site_skill_settings" s
   WHERE s."registry_team_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "teams" t WHERE t."id" = s."registry_team_id" AND t."registry");
  IF cleared IS NOT NULL THEN
    UPDATE "site_skill_settings" SET "registry_team_id" = NULL WHERE "registry_team_id" = cleared;
    RAISE NOTICE 'KOBE-330: team % was named the Registry team; cleared (create the Registry team in the Site console)', cleared;
  END IF;
END $$;--> statement-breakpoint
CREATE FUNCTION "public"."site_skill_settings_registry_team"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.registry_team_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "public"."teams" t WHERE t.id = NEW.registry_team_id AND t.registry) THEN
    RAISE EXCEPTION 'only the dedicated Registry team can be the Registry team' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "site_skill_settings_registry_team" BEFORE INSERT OR UPDATE OF "registry_team_id"
  ON "site_skill_settings" FOR EACH ROW EXECUTE FUNCTION "public"."site_skill_settings_registry_team"();--> statement-breakpoint
CREATE FUNCTION "public"."teams_registry_fixed"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.registry IS DISTINCT FROM OLD.registry THEN
    RAISE EXCEPTION 'a team''s registry flag is set at creation and never changes' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "teams_registry_fixed" BEFORE UPDATE OF "registry" ON "teams"
  FOR EACH ROW EXECUTE FUNCTION "public"."teams_registry_fixed"();
