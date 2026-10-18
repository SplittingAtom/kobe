-- KOBE-317: a catalog version's publisher is part of its immutable identity, and so are its
-- stored bytes once recorded: a storage key and size may be set where none was (a package stored
-- later, KOBE-333), never changed or cleared. Otherwise as 0133.
--
-- The review guard reads a version without a submitter (Kobe's own, which the CHECK
-- registry_versions_kobe_publisher keeps unreviewed) as no self-review, and leaves the rest of the
-- decision to that CHECK.
CREATE OR REPLACE FUNCTION public.registry_versions_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.skill_id IS DISTINCT FROM OLD.skill_id
      OR NEW.publisher IS DISTINCT FROM OLD.publisher
      OR NEW.semver IS DISTINCT FROM OLD.semver OR NEW.seq IS DISTINCT FROM OLD.seq
      OR NEW.runtime_hash IS DISTINCT FROM OLD.runtime_hash
      OR NEW.package_hash IS DISTINCT FROM OLD.package_hash
      OR NEW.manifest IS DISTINCT FROM OLD.manifest
      OR NEW.provenance IS DISTINCT FROM OLD.provenance
      OR NEW.source IS DISTINCT FROM OLD.source
      OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
      OR (OLD.runtime_storage_key IS NOT NULL
        AND (NEW.runtime_storage_key IS DISTINCT FROM OLD.runtime_storage_key
          OR NEW.runtime_size_bytes IS DISTINCT FROM OLD.runtime_size_bytes))
      OR (OLD.package_storage_key IS NOT NULL
        AND NEW.package_storage_key IS DISTINCT FROM OLD.package_storage_key) THEN
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
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.registry_versions_review_guard()
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
  IF NEW.reviewed_by IS NULL OR NEW.submitted_by IS NULL
      OR NEW.reviewed_by <> NEW.submitted_by THEN
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
$function$;
