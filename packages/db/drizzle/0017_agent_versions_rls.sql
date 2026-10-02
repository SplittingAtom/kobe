-- Team isolation for published team agent versions (spec D5): ENABLE + FORCE RLS and the canonical
-- policy, as in 0001_team_rls.sql. install_agent_versions is install-wide (personal and gallery
-- agents, D6); the server confines personal versions to their owner, and the app role may only
-- SELECT and INSERT it (tenancy grants).
ALTER TABLE "team_agent_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_agent_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_agent_versions"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Published versions are immutable (D19): no UPDATE, no direct DELETE, for any role. Threads pin
-- versions with NO ACTION foreign keys, and a version's content and frozen tool manifest must stay
-- what was published. The only delete that passes is a cascade (pg_trigger_depth() > 1: the
-- referential action of deleting the team runs it from its own trigger). A change of team_id is
-- left to RLS, whose WITH CHECK refuses every cross-team move with 42501 (the probe suite asserts
-- that error, so this trigger must not pre-empt it).
CREATE FUNCTION "public"."agent_versions_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'published agent versions are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  -- Nested: PL/pgSQL may evaluate both operands, and install versions have no team_id.
  IF TG_TABLE_NAME = 'team_agent_versions' THEN
    IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'published agent versions are immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "team_agent_versions_immutable" BEFORE UPDATE OR DELETE ON "team_agent_versions"
  FOR EACH ROW EXECUTE FUNCTION "public"."agent_versions_immutable"();--> statement-breakpoint
CREATE TRIGGER "install_agent_versions_immutable" BEFORE UPDATE OR DELETE ON "install_agent_versions"
  FOR EACH ROW EXECUTE FUNCTION "public"."agent_versions_immutable"();
