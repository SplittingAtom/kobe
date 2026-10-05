-- Team isolation, break-glass read and legal-hold guards for the artifact tables (KOBE-129, spec D5,
-- D10, D18, D25): the canonical policy as in 0005_conversations_rls.sql, a SELECT-only
-- break_glass_read policy shaped like thread_entries' (0023), and delete/truncate guards shaped
-- like thread_entries' (0033). Artifacts follow their thread, so a held thread's artifacts survive.

ALTER TABLE "artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "artifacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "artifacts"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "artifacts" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND "thread_id" = COALESCE((SELECT g.thread_id FROM "public"."break_glass_active_grant"() g), "thread_id")
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL OR EXISTS (
      SELECT 1 FROM "public"."threads" t
      WHERE t."team_id" = "artifacts"."team_id" AND t."id" = "artifacts"."thread_id"
        AND t."owner_user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g)))
  );--> statement-breakpoint
CREATE FUNCTION "public"."artifacts_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.thread_id FROM gone d) g
    LEFT JOIN "public"."threads" t ON t.team_id = g.team_id AND t.id = g.thread_id
    WHERE "public"."legal_hold_covers"(g.team_id, t.owner_user_id)) THEN
    RAISE EXCEPTION 'artifacts under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "artifacts_legal_hold" AFTER DELETE ON "artifacts"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."artifacts_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "artifacts_legal_hold_truncate" BEFORE TRUNCATE ON "artifacts"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint

ALTER TABLE "artifact_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "artifact_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "artifact_versions"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "artifact_versions" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND "thread_id" = COALESCE((SELECT g.thread_id FROM "public"."break_glass_active_grant"() g), "thread_id")
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL OR EXISTS (
      SELECT 1 FROM "public"."threads" t
      WHERE t."team_id" = "artifact_versions"."team_id" AND t."id" = "artifact_versions"."thread_id"
        AND t."owner_user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g)))
  );--> statement-breakpoint
CREATE FUNCTION "public"."artifact_versions_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.thread_id FROM gone d) g
    LEFT JOIN "public"."threads" t ON t.team_id = g.team_id AND t.id = g.thread_id
    WHERE "public"."legal_hold_covers"(g.team_id, t.owner_user_id)) THEN
    RAISE EXCEPTION 'artifact versions under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "artifact_versions_legal_hold" AFTER DELETE ON "artifact_versions"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."artifact_versions_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "artifact_versions_legal_hold_truncate" BEFORE TRUNCATE ON "artifact_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();
--> statement-breakpoint

-- Versions are immutable (KOBE-129 review): content, hash and thread never change after the write
-- (team_id is left to RLS and the foreign keys, as for every team table).
CREATE FUNCTION "public"."artifact_versions_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'artifact versions are immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "artifact_versions_immutable" BEFORE UPDATE OF "artifact_id", "version", "thread_id", "blob_ref", "size_bytes", "sha256", "run_id", "tool_call_id", "created_at" ON "artifact_versions"
  FOR EACH ROW EXECUTE FUNCTION "public"."artifact_versions_immutable"();
