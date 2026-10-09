-- Team isolation and a legal-hold guard for the files tables (KOBE-142, spec D5, D18): the
-- canonical policy as in 0005_conversations_rls.sql. A file is held with its owner: deleting or
-- truncating files of a user under a hold (or a team-wide hold) is refused, shaped like
-- artifacts' guards (0067). No break_glass_read policy yet: files are not thread-bound (thread_id
-- may be null), so the read-side design is left to the feature PR (see docs/ledger/KOBE-142.md).

ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "files"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
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
