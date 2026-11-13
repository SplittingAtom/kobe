-- KOBE-376 (v1.3 Semantic Memory SMA1): team isolation, legal-hold guards and SQL-only keys for
-- the tables of 0216, and the immutability of every version table. Custom, so db:rebase keeps this
-- SQL as written. The tables are new and empty.
--
-- Team tables (the three Workspace tables and the two run-record tables of the site-wide lanes):
-- ENABLE + FORCE RLS and the canonical policy, as in 0051_skills_rls.sql. No break_glass_read
-- policy yet (KOBE-386). Portable and Site tables are site-wide (no team_id, no RLS): the app role
-- reads them with the tenancy grants and the server filters them. No SECURITY DEFINER function or
-- view is added (KOBE-42 rule; the catalog check asserts it). pg_trgm (the trigram indexes in 0216)
-- is created by 0013_thread_search.sql.
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

ALTER TABLE "run_portable_memory_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_portable_memory_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "run_portable_memory_items"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "run_site_memory_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_site_memory_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "run_site_memory_items"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Legal hold (D18), as memory_docs (0074): a `user` item is held with its owner; a `team` item has
-- no owner, so any active hold in its team covers it (memory_legal_hold_covers with a NULL owner).
-- Deleting held items or versions, or truncating any of the team tables, is refused. Archiving and
-- superseding are UPDATEs and remove nothing. Run records are not content: they go with their run
-- or item (the item's guard decides), and only TRUNCATE is refused. Portable and Site items wait
-- for the Site-wide hold (KOBE-386).
CREATE FUNCTION "public"."semantic_memory_items_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.owner_user_id FROM gone d) g
    WHERE "public"."memory_legal_hold_covers"(g.team_id, g.owner_user_id)) THEN
    RAISE EXCEPTION 'memory under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "semantic_memory_items_legal_hold" AFTER DELETE ON "semantic_memory_items"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."semantic_memory_items_legal_hold_guard"();--> statement-breakpoint
-- A version follows its item's owner. Rows whose item is gone left with the item's cascade, whose
-- own guard (same statement, same transaction) already decided: skip them.
CREATE FUNCTION "public"."semantic_memory_item_versions_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT v.team_id, v.item_id FROM gone v) g
    JOIN "public"."semantic_memory_items" i ON i.team_id = g.team_id AND i.id = g.item_id
    WHERE "public"."memory_legal_hold_covers"(g.team_id, i.owner_user_id)) THEN
    RAISE EXCEPTION 'memory versions under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "semantic_memory_item_versions_legal_hold" AFTER DELETE ON "semantic_memory_item_versions"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."semantic_memory_item_versions_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "semantic_memory_items_legal_hold_truncate" BEFORE TRUNCATE ON "semantic_memory_items"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "semantic_memory_item_versions_legal_hold_truncate" BEFORE TRUNCATE ON "semantic_memory_item_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "run_memory_items_legal_hold_truncate" BEFORE TRUNCATE ON "run_memory_items"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "run_portable_memory_items_legal_hold_truncate" BEFORE TRUNCATE ON "run_portable_memory_items"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "run_site_memory_items_legal_hold_truncate" BEFORE TRUNCATE ON "run_site_memory_items"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint

-- current_version names an existing version (drizzle cannot express DEFERRABLE). Deferred to
-- commit, so an item and its first version are written in one transaction, in either order;
-- deleting an item takes its versions by cascade and leaves nothing to check.
ALTER TABLE "semantic_memory_items" ADD CONSTRAINT "semantic_memory_items_current_version_fk"
  FOREIGN KEY ("team_id", "id", "current_version")
  REFERENCES "semantic_memory_item_versions" ("team_id", "item_id", "version")
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "portable_memory_items" ADD CONSTRAINT "portable_memory_items_current_version_fk"
  FOREIGN KEY ("id", "current_version")
  REFERENCES "portable_memory_item_versions" ("item_id", "version")
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "site_memory_items" ADD CONSTRAINT "site_memory_items_current_version_fk"
  FOREIGN KEY ("id", "current_version")
  REFERENCES "site_memory_item_versions" ("item_id", "version")
  DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint

-- Versions are immutable (history and Undo: a restore appends a new version), as
-- skill_versions_immutable (0051): no direct DELETE for any role; the only delete that passes is a
-- cascade (pg_trigger_depth() > 1: deleting the item or the team runs it from a referential
-- trigger). A change of team_id is left to RLS, whose WITH CHECK refuses a cross-team move with
-- 42501 (the probe suite asserts that error, so this trigger must not pre-empt it).
-- One UPDATE passes, on Workspace versions only: the retention scrub, which sets evidence,
-- source_thread_id and source_entry_ids to NULL (each NULL or unchanged) and changes nothing else.
-- statement_tsv is left out of the comparison: it is generated (not yet computed in a BEFORE row
-- trigger) and follows statement, which must not change.
CREATE FUNCTION "public"."semantic_memory_versions_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  scrubbed constant text[] := ARRAY['evidence', 'source_thread_id', 'source_entry_ids', 'statement_tsv'];
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
    IF (to_jsonb(NEW) - scrubbed) = (to_jsonb(OLD) - scrubbed)
      AND (NEW.evidence IS NULL OR NEW.evidence IS NOT DISTINCT FROM OLD.evidence)
      AND (NEW.source_thread_id IS NULL OR NEW.source_thread_id IS NOT DISTINCT FROM OLD.source_thread_id)
      AND (NEW.source_entry_ids IS NULL OR NEW.source_entry_ids IS NOT DISTINCT FROM OLD.source_entry_ids) THEN
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
