-- Team isolation, break-glass read and legal-hold guards for the memory tables (KOBE-154, spec D5,
-- D10, D18, D24): the canonical policy as in 0005_conversations_rls.sql.
--
-- Break-glass (D24 "Memory follows team retention, break-glass, and legal hold"; D5 "Install admins
-- cannot read team content (threads, files, memory, artifacts) except through break-glass"): a
-- SELECT-only break_glass_read policy on memory_docs and memory_doc_versions, shaped like
-- thread_entries' (0023) but keyed on the owner, since memory is not thread content. A team grant
-- reads all of the team's memory (personal and project); a user grant reads that user's personal
-- memory only (project memory has no owner, so it is not "that user's"); a thread grant reads no
-- memory (memory belongs to no thread). team_memory_settings is configuration, not content: it
-- keeps only the team policy.
--
-- Legal hold (D18): a doc is held with its owner; a project doc has no owner, so any active hold in
-- its team covers it (a user-only hold must not let project memory the user contributed to go).
-- Deleting held docs or versions, or truncating either table, is refused. A soft delete
-- (deleted_at) is an UPDATE and removes nothing, so it stays allowed.

CREATE FUNCTION "public"."memory_legal_hold_covers"(team uuid, doc_owner uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT "public"."legal_hold_covers"(team, doc_owner)
    OR (doc_owner IS NULL AND EXISTS (
      SELECT 1 FROM "public"."legal_holds" h WHERE h.status = 'active' AND h.team_id = team))
$$;--> statement-breakpoint

ALTER TABLE "memory_docs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_docs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "memory_docs"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "memory_docs" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND (SELECT g.thread_id FROM "public"."break_glass_active_grant"() g) IS NULL
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL
      OR "owner_user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g))
  );--> statement-breakpoint
CREATE FUNCTION "public"."memory_docs_legal_hold_guard"() RETURNS trigger
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
CREATE TRIGGER "memory_docs_legal_hold" AFTER DELETE ON "memory_docs"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."memory_docs_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "memory_docs_legal_hold_truncate" BEFORE TRUNCATE ON "memory_docs"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint

ALTER TABLE "memory_doc_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_doc_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "memory_doc_versions"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "memory_doc_versions" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND (SELECT g.thread_id FROM "public"."break_glass_active_grant"() g) IS NULL
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL OR EXISTS (
      SELECT 1 FROM "public"."memory_docs" d
      WHERE d."team_id" = "memory_doc_versions"."team_id" AND d."id" = "memory_doc_versions"."doc_id"
        AND d."owner_user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g)))
  );--> statement-breakpoint
-- A version follows its doc's owner. When the doc is gone the rows left with a cascade from
-- memory_docs, whose own guard (same statement, same transaction) already decided: skip them.
CREATE FUNCTION "public"."memory_doc_versions_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT v.team_id, v.doc_id FROM gone v) g
    JOIN "public"."memory_docs" d ON d.team_id = g.team_id AND d.id = g.doc_id
    WHERE "public"."memory_legal_hold_covers"(g.team_id, d.owner_user_id)) THEN
    RAISE EXCEPTION 'memory versions under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "memory_doc_versions_legal_hold" AFTER DELETE ON "memory_doc_versions"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."memory_doc_versions_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "memory_doc_versions_legal_hold_truncate" BEFORE TRUNCATE ON "memory_doc_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint

-- Versions are immutable: Undo and history rely on them (team_id is left to RLS and the foreign
-- keys, as for every team table).
CREATE FUNCTION "public"."memory_doc_versions_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'memory versions are immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "memory_doc_versions_immutable" BEFORE UPDATE OF "doc_id", "version", "blob_ref", "size_bytes", "sha256", "actor_kind", "actor_user_id", "run_id", "tool_call_id", "created_at" ON "memory_doc_versions"
  FOR EACH ROW EXECUTE FUNCTION "public"."memory_doc_versions_immutable"();--> statement-breakpoint

ALTER TABLE "team_memory_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_memory_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_memory_settings"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
