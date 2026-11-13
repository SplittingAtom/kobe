-- KOBE-376 (v1.3 Semantic Memory SMA1): team isolation for the Workspace tables of 0216 and the
-- immutability of every version table. Custom, so db:rebase keeps this SQL as written. The tables
-- are new and empty.
--
-- Workspace tables: ENABLE + FORCE RLS and the canonical policy, as in 0051_skills_rls.sql. No
-- break_glass_read policy yet (KOBE-386 decides break-glass and holds for semantic memory).
-- Portable and Site tables are site-wide (no team_id, no RLS): the app role reads them with the
-- tenancy grants and the server filters them (owner; Site admins and stewards for writes). No
-- SECURITY DEFINER function or view is added (KOBE-42 rule; the catalog check asserts it).
-- pg_trgm (the Site and portable trigram indexes in 0216) is created by 0013_thread_search.sql.
ALTER TABLE "semantic_memory_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "semantic_memory_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "semantic_memory_items"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "semantic_memory_item_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "semantic_memory_item_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "semantic_memory_item_versions"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "run_memory_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_memory_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "run_memory_items"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Versions are immutable (history and Undo: a restore appends a new version): no UPDATE, no direct
-- DELETE, for any role. The only delete that passes is a cascade (pg_trigger_depth() > 1: deleting
-- the item, or the team, runs it from a referential trigger), as skill_versions_immutable (0051).
-- A change of team_id is left to RLS, whose WITH CHECK refuses a cross-team move with 42501 (the
-- probe suite asserts that error, so this trigger must not pre-empt it).
CREATE FUNCTION "public"."semantic_memory_versions_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'memory item versions are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  -- Nested: PL/pgSQL may evaluate both operands, and the site-wide versions have no team_id.
  IF TG_TABLE_NAME = 'semantic_memory_item_versions' THEN
    IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'memory item versions are immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "semantic_memory_item_versions_immutable"
  BEFORE UPDATE OR DELETE ON "semantic_memory_item_versions"
  FOR EACH ROW EXECUTE FUNCTION "public"."semantic_memory_versions_immutable"();--> statement-breakpoint
CREATE TRIGGER "portable_memory_item_versions_immutable"
  BEFORE UPDATE OR DELETE ON "portable_memory_item_versions"
  FOR EACH ROW EXECUTE FUNCTION "public"."semantic_memory_versions_immutable"();--> statement-breakpoint
CREATE TRIGGER "site_memory_item_versions_immutable"
  BEFORE UPDATE OR DELETE ON "site_memory_item_versions"
  FOR EACH ROW EXECUTE FUNCTION "public"."semantic_memory_versions_immutable"();
