-- Team isolation for skill bundles (spec D5, KOBE-78): ENABLE + FORCE RLS and the canonical policy,
-- as in 0001_team_rls.sql. install_skills and install_skill_versions are install-wide (personal
-- skills, D9); the server confines them to their owner, and the app role may only SELECT and
-- INSERT the versions (tenancy grants).
ALTER TABLE "team_skills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skills" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_skills"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "team_skill_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_skill_versions"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Uploaded skill versions are immutable (KOBE-78): no UPDATE, no direct DELETE, for any role. What
-- the blocklist hashes and materialization copies must stay what was uploaded. The only delete that
-- passes is a cascade (pg_trigger_depth() > 1: deleting the team runs it from its own referential
-- trigger; no other trigger or function may ever delete versions). A change of team_id is left to
-- RLS, whose WITH CHECK refuses every cross-team move with 42501 (the probe suite asserts that
-- error, so this trigger must not pre-empt it).
CREATE FUNCTION "public"."skill_versions_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'uploaded skill versions are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  -- Nested: PL/pgSQL may evaluate both operands, and install versions have no team_id.
  IF TG_TABLE_NAME = 'team_skill_versions' THEN
    IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'uploaded skill versions are immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "team_skill_versions_immutable" BEFORE UPDATE OR DELETE ON "team_skill_versions"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_versions_immutable"();--> statement-breakpoint
CREATE TRIGGER "install_skill_versions_immutable" BEFORE UPDATE OR DELETE ON "install_skill_versions"
  FOR EACH ROW EXECUTE FUNCTION "public"."skill_versions_immutable"();
