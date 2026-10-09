-- Team isolation and a legal-hold guard for the files tables (KOBE-142, spec D5, D18): the
-- canonical policy as in 0005_conversations_rls.sql. A file is held with its owner: deleting or
-- truncating files of a user under a hold (or a team-wide hold) is refused, shaped like
-- artifacts' guards (0067). Break-glass read (D10): a SELECT-only break_glass_read policy shaped
-- exactly like artifacts' (0067, thread_entries' in 0023), so a read of a thread sees its uploads
-- and shared files. It covers thread-bound rows only: with thread_id NULL the thread comparison is
-- NULL, so files outside any thread stay team-isolation only (never visible to break-glass).

ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "files"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "files" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND "thread_id" = COALESCE((SELECT g.thread_id FROM "public"."break_glass_active_grant"() g), "thread_id")
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL OR EXISTS (
      SELECT 1 FROM "public"."threads" t
      WHERE t."team_id" = "files"."team_id" AND t."id" = "files"."thread_id"
        AND t."owner_user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g)))
  );--> statement-breakpoint
CREATE FUNCTION "public"."files_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.user_id FROM gone d) g
    WHERE "public"."legal_hold_covers"(g.team_id, g.user_id)) THEN
    RAISE EXCEPTION 'files under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "files_legal_hold" AFTER DELETE ON "files"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."files_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "files_legal_hold_truncate" BEFORE TRUNCATE ON "files"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint

ALTER TABLE "team_storage_quotas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_storage_quotas" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_storage_quotas"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
