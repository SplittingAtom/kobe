-- KOBE-378 (v1.3 Semantic Memory SMA3): the version cap. Past the Site setting `version_cap` the
-- server prunes an item's oldest versions on write, so `semantic_memory_versions_immutable()`
-- (0217) now lets a direct DELETE through for one case only: the version is NOT its item's
-- current_version AND no run record (run_memory_items / run_portable_memory_items /
-- run_site_memory_items) points at it, so run history (U48, context viewer) survives pruning.
-- Everything else stays as in 0217: cascades from deleting the whole item or team pass
-- (pg_trigger_depth() > 1), every UPDATE but the retention scrub is refused, and the KH001 legal
-- hold guards of 0217 still refuse deleting held Workspace versions.
--
-- Run records of the site-wide lanes live in team tables under FORCE RLS, so the version trigger
-- (invoker rights, never SECURITY DEFINER) sees only the active Workspace's. Another Workspace's
-- records would go by the version's ON DELETE CASCADE (referential actions ignore RLS), so a guard
-- on the three run-record tables refuses that cascade: a run record whose version is gone while its
-- item still exists was removed by pruning (an item or team delete takes the item first; a run's
-- own delete leaves the version). The guard reads only site-wide rows or rows of the record's own
-- Workspace and never sets the team. The app role gets DELETE on the site-wide version tables via
-- the grants matrix (tenancy/memory.ts), applied by migrate after this file.
CREATE OR REPLACE FUNCTION "public"."semantic_memory_versions_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  scrubbed constant text[] := ARRAY['evidence', 'source_thread_id', 'source_entry_ids', 'statement_tsv'];
  prunable boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    -- Pruning: a non-current version no visible run record uses (the run-record guard below
    -- covers the records this trigger cannot see).
    IF TG_TABLE_NAME = 'semantic_memory_item_versions' THEN
      prunable := EXISTS (
          SELECT 1 FROM "public"."semantic_memory_items" i
          WHERE i.team_id = OLD.team_id AND i.id = OLD.item_id AND i.current_version <> OLD.version)
        AND NOT EXISTS (
          SELECT 1 FROM "public"."run_memory_items" r
          WHERE r.team_id = OLD.team_id AND r.item_id = OLD.item_id AND r.version = OLD.version);
    ELSIF TG_TABLE_NAME = 'portable_memory_item_versions' THEN
      prunable := EXISTS (
          SELECT 1 FROM "public"."portable_memory_items" i
          WHERE i.id = OLD.item_id AND i.current_version <> OLD.version)
        AND NOT EXISTS (
          SELECT 1 FROM "public"."run_portable_memory_items" r
          WHERE r.item_id = OLD.item_id AND r.version = OLD.version);
    ELSIF TG_TABLE_NAME = 'site_memory_item_versions' THEN
      prunable := EXISTS (
          SELECT 1 FROM "public"."site_memory_items" i
          WHERE i.id = OLD.item_id AND i.current_version <> OLD.version)
        AND NOT EXISTS (
          SELECT 1 FROM "public"."run_site_memory_items" r
          WHERE r.item_id = OLD.item_id AND r.version = OLD.version);
    END IF;
    IF prunable THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'only a non-current memory item version no run used can be deleted'
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
      IF (NEW.evidence, NEW.source_thread_id, NEW.source_entry_ids)
          IS DISTINCT FROM (OLD.evidence, OLD.source_thread_id, OLD.source_entry_ids) THEN
        PERFORM "public"."legal_hold_lock_shared"();
        IF "public"."memory_legal_hold_covers"(NEW.team_id, (
            SELECT i.owner_user_id FROM "public"."semantic_memory_items" i
            WHERE i.team_id = NEW.team_id AND i.id = NEW.item_id)) THEN
          RAISE EXCEPTION 'memory under legal hold cannot be scrubbed' USING ERRCODE = 'KH001';
        END IF;
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'memory item versions are immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

-- A run record removed because its version was pruned (version gone, item still there) is refused,
-- in any Workspace. Item, team and run deletes pass (see above); a team delete may reach Workspace
-- versions before their items (the order of the team's cascades is not fixed), so a Workspace record
-- whose team is gone passes too.
CREATE FUNCTION "public"."run_memory_items_prune_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'run_memory_items' THEN
    IF EXISTS (
      SELECT 1 FROM gone g
      JOIN "public"."teams" t ON t.id = g.team_id
      JOIN "public"."semantic_memory_items" i ON i.team_id = g.team_id AND i.id = g.item_id
      WHERE NOT EXISTS (
        SELECT 1 FROM "public"."semantic_memory_item_versions" v
        WHERE v.team_id = g.team_id AND v.item_id = g.item_id AND v.version = g.version)) THEN
      RAISE EXCEPTION 'a memory item version a run used cannot be pruned' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'run_portable_memory_items' THEN
    IF EXISTS (
      SELECT 1 FROM gone g
      JOIN "public"."portable_memory_items" i ON i.id = g.item_id
      WHERE NOT EXISTS (
        SELECT 1 FROM "public"."portable_memory_item_versions" v
        WHERE v.item_id = g.item_id AND v.version = g.version)) THEN
      RAISE EXCEPTION 'a memory item version a run used cannot be pruned' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'run_site_memory_items' THEN
    IF EXISTS (
      SELECT 1 FROM gone g
      JOIN "public"."site_memory_items" i ON i.id = g.item_id
      WHERE NOT EXISTS (
        SELECT 1 FROM "public"."site_memory_item_versions" v
        WHERE v.item_id = g.item_id AND v.version = g.version)) THEN
      RAISE EXCEPTION 'a memory item version a run used cannot be pruned' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "run_memory_items_prune_guard" AFTER DELETE ON "run_memory_items"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."run_memory_items_prune_guard"();--> statement-breakpoint
CREATE TRIGGER "run_portable_memory_items_prune_guard" AFTER DELETE ON "run_portable_memory_items"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."run_memory_items_prune_guard"();--> statement-breakpoint
CREATE TRIGGER "run_site_memory_items_prune_guard" AFTER DELETE ON "run_site_memory_items"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."run_memory_items_prune_guard"();
