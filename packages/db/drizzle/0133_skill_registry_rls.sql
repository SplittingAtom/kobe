-- KOBE-311 (Skills v1.2, SK5–SK8, SK21–SK25): row security, seeds and the system-tag guard for
-- 0132_skill_registry. Custom, so db:rebase keeps this SQL as written. The tables are new and
-- empty, so nothing is backfilled and FORCE RLS needs no lifting.
--
-- Team isolation, as in 0001_team_rls.sql: ENABLE + FORCE RLS and the canonical policy.
ALTER TABLE "team_skill_installs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_installs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_skill_installs"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "team_skill_optouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_optouts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_skill_optouts"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "team_skill_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_blocks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_skill_blocks"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "member_skill_enablements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "member_skill_enablements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "member_skill_enablements"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
-- The one Registry settings row (site-wide singleton, like site_model_limits).
INSERT INTO "site_skill_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The code-defined system tags (SK5): v1.2 has Default only. The check
-- registry_tags_system_set refuses any other system name; these triggers refuse deleting a
-- system tag, changing its id, name, kind or status, or truncating the table: for the app role,
-- and for the owner outside restore (which disables user triggers) and migrations.
INSERT INTO "registry_tags" ("name", "kind") VALUES ('default', 'system')
  ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
CREATE FUNCTION public.registry_tags_system_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'registry_tags holds the system tags and cannot be truncated'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.kind = 'system' AND (TG_OP = 'DELETE' OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.name IS DISTINCT FROM OLD.name OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'system tags are defined by Kobe and cannot be changed or deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "registry_tags_system_guard" BEFORE UPDATE OR DELETE ON "registry_tags"
  FOR EACH ROW EXECUTE FUNCTION public.registry_tags_system_guard();--> statement-breakpoint
CREATE TRIGGER "registry_tags_refuse_truncate" BEFORE TRUNCATE ON "registry_tags"
  FOR EACH STATEMENT EXECUTE FUNCTION public.registry_tags_system_guard();--> statement-breakpoint
-- A catalog version's identity is immutable (as local versions', 0051): what a human reviewed is
-- what every installing team runs. Only the review state, claim, review, scan and verdict
-- (rescans on a rule-set change, SK32), scorecards, mirror and updated_at change; a new package is
-- a new version.
CREATE FUNCTION public.registry_versions_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.skill_id IS DISTINCT FROM OLD.skill_id
      OR NEW.semver IS DISTINCT FROM OLD.semver OR NEW.seq IS DISTINCT FROM OLD.seq
      OR NEW.runtime_hash IS DISTINCT FROM OLD.runtime_hash
      OR NEW.package_hash IS DISTINCT FROM OLD.package_hash
      OR NEW.manifest IS DISTINCT FROM OLD.manifest
      OR NEW.provenance IS DISTINCT FROM OLD.provenance
      OR NEW.source IS DISTINCT FROM OLD.source
      OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'a catalog version''s package and submission are immutable'
      USING ERRCODE = '55000';
  END IF;
  -- Once published, a version can only move between published states (approved, deprecated,
  -- withdrawn, revoked): it never goes back into review.
  IF OLD.state IN ('approved', 'deprecated', 'withdrawn', 'revoked')
      AND NEW.state NOT IN ('approved', 'deprecated', 'withdrawn', 'revoked') THEN
    RAISE EXCEPTION 'a published catalog version cannot go back into review'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "registry_versions_immutable" BEFORE UPDATE ON "registry_versions"
  FOR EACH ROW EXECUTE FUNCTION public.registry_versions_immutable();--> statement-breakpoint
-- Separation of duties (SK22): nobody reviews their own submission, except that a single-admin
-- Site may self-approve, flagged, as with break-glass (D10, 0091). The database decides the flag:
-- a review by the submitter must be an approval by an active Site admin while no other active
-- Site admin and no other active skill reviewer exists. Both sets are read under the site
-- admin-set lock, which site_roles, users.deactivated_at and site_grants changes also take, so a
-- concurrent promotion or grant cannot slip past the check. Once approved, the review (reviewer,
-- time and flag) is frozen. Invoker rights, pinned search_path.
CREATE FUNCTION public.registry_versions_review_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.approved_at IS NOT NULL THEN
    IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
        OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
        OR NEW.self_approved IS DISTINCT FROM OLD.self_approved THEN
      RAISE EXCEPTION 'an approved catalog version''s review cannot be changed'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.reviewed_by THEN
    NEW.self_approved := OLD.self_approved;
    RETURN NEW;
  END IF;
  IF NEW.reviewed_by IS NULL OR NEW.reviewed_by <> NEW.submitted_by THEN
    NEW.self_approved := false;
    RETURN NEW;
  END IF;
  IF NEW.approved_at IS NULL THEN
    RAISE EXCEPTION 'withdraw your own submission instead of reviewing it'
      USING ERRCODE = '42501';
  END IF;
  PERFORM "public"."break_glass_lock_admin_set"();
  IF NOT "public"."break_glass_is_site_admin"(NEW.reviewed_by) THEN
    RAISE EXCEPTION 'a second reviewer must approve this version' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM "public"."site_roles" r JOIN "public"."users" u ON u.id = r.user_id
    WHERE r.user_id <> NEW.submitted_by AND u.deactivated_at IS NULL
    FOR SHARE OF r, u;
  IF FOUND THEN
    RAISE EXCEPTION 'a second reviewer must approve this version' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM "public"."site_grants" g JOIN "public"."users" u ON u.id = g.user_id
    WHERE g."grant" = 'skill_reviewer' AND g.user_id <> NEW.submitted_by
      AND u.deactivated_at IS NULL
    FOR SHARE OF u;
  IF FOUND THEN
    RAISE EXCEPTION 'a second reviewer must approve this version' USING ERRCODE = '42501';
  END IF;
  NEW.self_approved := true;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "registry_versions_review_guard" BEFORE INSERT OR UPDATE ON "registry_versions"
  FOR EACH ROW EXECUTE FUNCTION public.registry_versions_review_guard();--> statement-breakpoint
CREATE TRIGGER "site_grants_admin_set_lock" BEFORE INSERT OR UPDATE OR DELETE ON "site_grants"
  FOR EACH STATEMENT EXECUTE FUNCTION public.break_glass_admin_set_changed();--> statement-breakpoint
-- A Team admin's block of a catalog skill (SK25) refuses members' adds of it and removes the
-- existing ones. Invoker rights: both run inside the team's own transaction, under its RLS.
CREATE FUNCTION public.member_skill_enablements_blocked()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.catalog_skill_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_skill_blocks b
       WHERE b.team_id = NEW.team_id AND b.skill_id = NEW.catalog_skill_id) THEN
    RAISE EXCEPTION 'this catalog skill is blocked in the team' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "member_skill_enablements_blocked" BEFORE INSERT OR UPDATE ON "member_skill_enablements"
  FOR EACH ROW EXECUTE FUNCTION public.member_skill_enablements_blocked();--> statement-breakpoint
CREATE FUNCTION public.team_skill_blocks_remove_adds()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  DELETE FROM member_skill_enablements e
   WHERE e.team_id = NEW.team_id AND e.catalog_skill_id = NEW.skill_id;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "team_skill_blocks_remove_adds" AFTER INSERT ON "team_skill_blocks"
  FOR EACH ROW EXECUTE FUNCTION public.team_skill_blocks_remove_adds();
