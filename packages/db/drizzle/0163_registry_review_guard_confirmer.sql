-- KOBE-334 review M2 (coordinator decision): separation of duties covers the Team admin who
-- confirmed a Builder's promotion (provenance `confirmedBy`) as it covers the submitter. Either may
-- approve only on a single-admin Site, and the database flags that approval `self_approved` (0160
-- widened the CHECK to match). The confirmer may still send a version back or reject it; the
-- submitter may not (they withdraw instead). The other reviewers are counted apart from the one
-- approving. Also: the "review unchanged" shortcut now needs the approval time unchanged too, so an
-- approval is always decided here. Custom, so db:rebase keeps this SQL as written. Invoker rights,
-- pinned search_path, as 0133.
CREATE OR REPLACE FUNCTION public.registry_versions_review_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  by_submitter boolean;
  by_confirmer boolean;
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
  IF TG_OP = 'UPDATE' AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.reviewed_by
      AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at THEN
    NEW.self_approved := OLD.self_approved;
    RETURN NEW;
  END IF;
  -- IS NOT DISTINCT FROM: a Kobe-published version has no submitter (NULL), and a NULL here
  -- would skip the "not the submitter's" branch below.
  by_submitter := NEW.reviewed_by IS NOT NULL
    AND NEW.reviewed_by IS NOT DISTINCT FROM NEW.submitted_by;
  by_confirmer := NEW.reviewed_by IS NOT NULL
    AND NEW.reviewed_by::text IS NOT DISTINCT FROM (NEW.provenance #>> '{confirmedBy,userId}');
  IF NOT (by_submitter OR by_confirmer) THEN
    NEW.self_approved := false;
    RETURN NEW;
  END IF;
  IF NEW.approved_at IS NULL THEN
    IF by_submitter THEN
      RAISE EXCEPTION 'withdraw your own submission instead of reviewing it'
        USING ERRCODE = '42501';
    END IF;
    NEW.self_approved := false;
    RETURN NEW;
  END IF;
  PERFORM "public"."break_glass_lock_admin_set"();
  IF NOT "public"."break_glass_is_site_admin"(NEW.reviewed_by) THEN
    RAISE EXCEPTION 'a second reviewer must approve this version' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM "public"."site_roles" r JOIN "public"."users" u ON u.id = r.user_id
    WHERE r.user_id <> NEW.reviewed_by AND u.deactivated_at IS NULL
    FOR SHARE OF r, u;
  IF FOUND THEN
    RAISE EXCEPTION 'a second reviewer must approve this version' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM "public"."site_grants" g JOIN "public"."users" u ON u.id = g.user_id
    WHERE g."grant" = 'skill_reviewer' AND g.user_id <> NEW.reviewed_by
      AND u.deactivated_at IS NULL
    FOR SHARE OF u;
  IF FOUND THEN
    RAISE EXCEPTION 'a second reviewer must approve this version' USING ERRCODE = '42501';
  END IF;
  NEW.self_approved := true;
  RETURN NEW;
END;
$function$;
