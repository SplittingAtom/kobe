-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-256 (R3): "Site" replaces "Install" in the database. Every install_* object is renamed in
-- place (ALTER ... RENAME: catalog only, no table rewrite, no data copied), so an existing site
-- upgrades with its rows intact. The migration Job runs before the new pods start; server and
-- gateway pods of the previous release fail on the renamed tables until Helm replaces them.
--
-- Enum types (the enum values themselves never said "install").
ALTER TYPE "install_role" RENAME TO "site_role";--> statement-breakpoint
ALTER TYPE "install_agent_scope" RENAME TO "site_agent_scope";--> statement-breakpoint
-- Tables (their row types follow), and the thread pin's generated column.
ALTER TABLE "install_settings" RENAME TO "site_settings";--> statement-breakpoint
ALTER TABLE "install_roles" RENAME TO "site_roles";--> statement-breakpoint
ALTER TABLE "install_model_limits" RENAME TO "site_model_limits";--> statement-breakpoint
ALTER TABLE "install_model_spend_daily" RENAME TO "site_model_spend_daily";--> statement-breakpoint
ALTER TABLE "install_budget_reservations" RENAME TO "site_budget_reservations";--> statement-breakpoint
ALTER TABLE "install_tool_rules" RENAME TO "site_tool_rules";--> statement-breakpoint
ALTER TABLE "install_agents" RENAME TO "site_agents";--> statement-breakpoint
ALTER TABLE "install_agent_versions" RENAME TO "site_agent_versions";--> statement-breakpoint
ALTER TABLE "install_skills" RENAME TO "site_skills";--> statement-breakpoint
ALTER TABLE "install_skill_versions" RENAME TO "site_skill_versions";--> statement-breakpoint
ALTER TABLE "install_skill_scans" RENAME TO "site_skill_scans";--> statement-breakpoint
ALTER TABLE "threads" RENAME COLUMN "install_agent_id" TO "site_agent_id";--> statement-breakpoint
-- Constraints (a primary key or unique constraint renames its index too), indexes, triggers.
ALTER TABLE "gallery_agent_scores" RENAME CONSTRAINT "gallery_agent_scores_agent_id_install_agents_id_fk" TO "gallery_agent_scores_agent_id_site_agents_id_fk";--> statement-breakpoint
ALTER TABLE "site_agent_versions" RENAME CONSTRAINT "install_agent_versions_agent_fk" TO "site_agent_versions_agent_fk";--> statement-breakpoint
ALTER TABLE "site_agent_versions" RENAME CONSTRAINT "install_agent_versions_agent_id_version_pk" TO "site_agent_versions_agent_id_version_pk";--> statement-breakpoint
ALTER TABLE "site_agent_versions" RENAME CONSTRAINT "install_agent_versions_frontmatter_object" TO "site_agent_versions_frontmatter_object";--> statement-breakpoint
ALTER TABLE "site_agent_versions" RENAME CONSTRAINT "install_agent_versions_origin" TO "site_agent_versions_origin";--> statement-breakpoint
ALTER TABLE "site_agent_versions" RENAME CONSTRAINT "install_agent_versions_prompt_size" TO "site_agent_versions_prompt_size";--> statement-breakpoint
ALTER TABLE "site_agent_versions" RENAME CONSTRAINT "install_agent_versions_published_by_users_id_fk" TO "site_agent_versions_published_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "site_agent_versions" RENAME CONSTRAINT "install_agent_versions_tool_manifest_object" TO "site_agent_versions_tool_manifest_object";--> statement-breakpoint
ALTER TABLE "site_agent_versions" RENAME CONSTRAINT "install_agent_versions_version_positive" TO "site_agent_versions_version_positive";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_archived_by" TO "site_agents_archived_by";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_current_version_fk" TO "site_agents_current_version_fk";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_current_version_positive" TO "site_agents_current_version_positive";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_fork_version" TO "site_agents_fork_version";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_frontmatter_object" TO "site_agents_frontmatter_object";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_gallery_generation" TO "site_agents_gallery_generation";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_gallery_key_scope" TO "site_agents_gallery_key_scope";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_owner_by_scope" TO "site_agents_owner_by_scope";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_owner_user_id_users_id_fk" TO "site_agents_owner_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_pkey" TO "site_agents_pkey";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_prompt_size" TO "site_agents_prompt_size";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_revision_positive" TO "site_agents_revision_positive";--> statement-breakpoint
ALTER TABLE "site_agents" RENAME CONSTRAINT "install_agents_slug_format" TO "site_agents_slug_format";--> statement-breakpoint
ALTER TABLE "site_budget_reservations" RENAME CONSTRAINT "install_budget_reservations_amounts" TO "site_budget_reservations_amounts";--> statement-breakpoint
ALTER TABLE "site_budget_reservations" RENAME CONSTRAINT "install_budget_reservations_call_id_len" TO "site_budget_reservations_call_id_len";--> statement-breakpoint
ALTER TABLE "site_budget_reservations" RENAME CONSTRAINT "install_budget_reservations_team_key_call_id_pk" TO "site_budget_reservations_team_key_call_id_pk";--> statement-breakpoint
ALTER TABLE "site_model_limits" RENAME CONSTRAINT "install_model_limits_amounts" TO "site_model_limits_amounts";--> statement-breakpoint
ALTER TABLE "site_model_limits" RENAME CONSTRAINT "install_model_limits_pkey" TO "site_model_limits_pkey";--> statement-breakpoint
ALTER TABLE "site_model_limits" RENAME CONSTRAINT "install_model_limits_rpm" TO "site_model_limits_rpm";--> statement-breakpoint
ALTER TABLE "site_model_limits" RENAME CONSTRAINT "install_model_limits_singleton" TO "site_model_limits_singleton";--> statement-breakpoint
ALTER TABLE "site_model_limits" RENAME CONSTRAINT "install_model_limits_updated_by_users_id_fk" TO "site_model_limits_updated_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "site_model_spend_daily" RENAME CONSTRAINT "install_model_spend_daily_pkey" TO "site_model_spend_daily_pkey";--> statement-breakpoint
ALTER TABLE "site_roles" RENAME CONSTRAINT "install_roles_user_id_pk" TO "site_roles_user_id_pk";--> statement-breakpoint
ALTER TABLE "site_roles" RENAME CONSTRAINT "install_roles_user_id_users_id_fk" TO "site_roles_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "site_settings" RENAME CONSTRAINT "install_settings_pkey" TO "site_settings_pkey";--> statement-breakpoint
ALTER TABLE "site_skill_scans" RENAME CONSTRAINT "install_skill_scans_skill_id_version_pk" TO "site_skill_scans_skill_id_version_pk";--> statement-breakpoint
ALTER TABLE "site_skill_scans" RENAME CONSTRAINT "install_skill_scans_version_fk" TO "site_skill_scans_version_fk";--> statement-breakpoint
ALTER TABLE "site_skill_versions" RENAME CONSTRAINT "install_skill_versions_content_hash_format" TO "site_skill_versions_content_hash_format";--> statement-breakpoint
ALTER TABLE "site_skill_versions" RENAME CONSTRAINT "install_skill_versions_frontmatter_object" TO "site_skill_versions_frontmatter_object";--> statement-breakpoint
ALTER TABLE "site_skill_versions" RENAME CONSTRAINT "install_skill_versions_sizes" TO "site_skill_versions_sizes";--> statement-breakpoint
ALTER TABLE "site_skill_versions" RENAME CONSTRAINT "install_skill_versions_skill_fk" TO "site_skill_versions_skill_fk";--> statement-breakpoint
ALTER TABLE "site_skill_versions" RENAME CONSTRAINT "install_skill_versions_skill_id_version_pk" TO "site_skill_versions_skill_id_version_pk";--> statement-breakpoint
ALTER TABLE "site_skill_versions" RENAME CONSTRAINT "install_skill_versions_uploaded_by_users_id_fk" TO "site_skill_versions_uploaded_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "site_skill_versions" RENAME CONSTRAINT "install_skill_versions_version_positive" TO "site_skill_versions_version_positive";--> statement-breakpoint
ALTER TABLE "site_skills" RENAME CONSTRAINT "install_skills_description_size" TO "site_skills_description_size";--> statement-breakpoint
ALTER TABLE "site_skills" RENAME CONSTRAINT "install_skills_latest_version_positive" TO "site_skills_latest_version_positive";--> statement-breakpoint
ALTER TABLE "site_skills" RENAME CONSTRAINT "install_skills_owner_user_id_users_id_fk" TO "site_skills_owner_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "site_skills" RENAME CONSTRAINT "install_skills_pkey" TO "site_skills_pkey";--> statement-breakpoint
ALTER TABLE "site_skills" RENAME CONSTRAINT "install_skills_slug_format" TO "site_skills_slug_format";--> statement-breakpoint
ALTER TABLE "site_skills" RENAME CONSTRAINT "install_skills_slug_unique" TO "site_skills_slug_unique";--> statement-breakpoint
ALTER TABLE "site_tool_rules" RENAME CONSTRAINT "install_tool_rules_arg_pattern" TO "site_tool_rules_arg_pattern";--> statement-breakpoint
ALTER TABLE "site_tool_rules" RENAME CONSTRAINT "install_tool_rules_created_by_users_id_fk" TO "site_tool_rules_created_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "site_tool_rules" RENAME CONSTRAINT "install_tool_rules_effect" TO "site_tool_rules_effect";--> statement-breakpoint
ALTER TABLE "site_tool_rules" RENAME CONSTRAINT "install_tool_rules_glob" TO "site_tool_rules_glob";--> statement-breakpoint
ALTER TABLE "site_tool_rules" RENAME CONSTRAINT "install_tool_rules_note" TO "site_tool_rules_note";--> statement-breakpoint
ALTER TABLE "site_tool_rules" RENAME CONSTRAINT "install_tool_rules_pkey" TO "site_tool_rules_pkey";--> statement-breakpoint
ALTER TABLE "threads" RENAME CONSTRAINT "threads_install_agent_version_fk" TO "threads_site_agent_version_fk";--> statement-breakpoint
ALTER INDEX "install_agents_gallery_key_unique" RENAME TO "site_agents_gallery_key_unique";--> statement-breakpoint
ALTER INDEX "install_agents_gallery_slug_unique" RENAME TO "site_agents_gallery_slug_unique";--> statement-breakpoint
ALTER INDEX "install_agents_personal_slug_unique" RENAME TO "site_agents_personal_slug_unique";--> statement-breakpoint
ALTER INDEX "install_budget_reservations_expiry_idx" RENAME TO "site_budget_reservations_expiry_idx";--> statement-breakpoint
ALTER INDEX "install_roles_single_owner" RENAME TO "site_roles_single_owner";--> statement-breakpoint
ALTER INDEX "threads_install_agent_idx" RENAME TO "threads_site_agent_idx";--> statement-breakpoint
ALTER TRIGGER "install_agent_versions_immutable" ON "site_agent_versions" RENAME TO "site_agent_versions_immutable";--> statement-breakpoint
ALTER TRIGGER "install_model_limits_guard" ON "site_model_limits" RENAME TO "site_model_limits_guard";--> statement-breakpoint
ALTER TRIGGER "install_model_spend_daily_guard" ON "site_model_spend_daily" RENAME TO "site_model_spend_daily_guard";--> statement-breakpoint
ALTER TRIGGER "install_roles_admin_set_lock" ON "site_roles" RENAME TO "site_roles_admin_set_lock";--> statement-breakpoint
ALTER TRIGGER "install_skill_versions_immutable" ON "site_skill_versions" RENAME TO "site_skill_versions_immutable";--> statement-breakpoint
-- Functions: plpgsql and SQL bodies name tables as text, so every body that named an install_*
-- table, function, lock key or scope is replaced (CREATE OR REPLACE keeps owner, grants and the
-- triggers and policies that use them). Two functions are renamed first.
ALTER FUNCTION "break_glass_is_install_admin"(uuid) RENAME TO "break_glass_is_site_admin";--> statement-breakpoint
ALTER FUNCTION "kobe_install_limits_guard"() RENAME TO "kobe_site_limits_guard";--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.agent_versions_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'published agent versions are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  -- Nested: PL/pgSQL may evaluate both operands, and site versions have no team_id.
  IF TG_TABLE_NAME = 'team_agent_versions' THEN
    IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'published agent versions are immutable' USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.threads_agent_pin_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  pinned_scope text;
  pinned_owner uuid;
BEGIN
  IF NEW.agent_scope IS NULL OR NEW.agent_scope = 'team' THEN
    RETURN NEW;
  END IF;
  SELECT a.scope::text, a.owner_user_id INTO pinned_scope, pinned_owner
    FROM "public"."site_agents" a WHERE a.id = NEW.agent_id;
  IF NOT FOUND OR pinned_scope <> NEW.agent_scope::text
     OR (pinned_scope = 'personal' AND pinned_owner IS DISTINCT FROM NEW.owner_user_id) THEN
    RAISE EXCEPTION 'thread pin: agent % is not a % agent available to the thread owner',
      NEW.agent_id, NEW.agent_scope USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.break_glass_is_site_admin(who uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM "public"."site_roles" r JOIN "public"."users" u ON u.id = r.user_id
    WHERE r.user_id = who AND u.deactivated_at IS NULL)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.break_glass_lock_admin_set()
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT pg_advisory_xact_lock(hashtextextended('kobe.site_admin_set', 0))
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.break_glass_grants_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Every grant starts as a pending request; the database stamps its times.
    IF NEW.status <> 'pending' OR NEW.approver_id IS NOT NULL OR NEW.self_approved
       OR NEW.decided_at IS NOT NULL OR NEW.decided_by IS NOT NULL OR NEW.starts_at IS NOT NULL
       OR NEW.expires_at IS NOT NULL OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'break-glass grants start as pending requests' USING ERRCODE = '55000';
    END IF;
    IF NOT "public"."break_glass_is_site_admin"(NEW.admin_id) THEN
      RAISE EXCEPTION 'only a site admin can request break-glass' USING ERRCODE = '42501';
    END IF;
    NEW.requested_at := now();
    NEW.request_expires_at := now() + interval '24 hours';
    RETURN NEW;
  END IF;

  -- What was asked for never changes.
  IF (NEW.id, NEW.team_id, NEW.admin_id, NEW.user_id, NEW.thread_id, NEW.reason, NEW.legal_hold,
      NEW.duration_minutes, NEW.requested_at, NEW.request_expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.team_id, OLD.admin_id, OLD.user_id, OLD.thread_id, OLD.reason, OLD.legal_hold,
      OLD.duration_minutes, OLD.requested_at, OLD.request_expires_at) THEN
    RAISE EXCEPTION 'a break-glass request cannot be changed' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = OLD.status THEN
    IF (NEW.approver_id, NEW.self_approved, NEW.decided_at, NEW.decided_by, NEW.starts_at,
        NEW.expires_at, NEW.ended_at)
       IS DISTINCT FROM
       (OLD.approver_id, OLD.self_approved, OLD.decided_at, OLD.decided_by, OLD.starts_at,
        OLD.expires_at, OLD.ended_at) THEN
      RAISE EXCEPTION 'a break-glass decision cannot be changed' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
    IF now() >= OLD.request_expires_at THEN
      RAISE EXCEPTION 'the break-glass request lapsed' USING ERRCODE = '55000';
    END IF;
    PERFORM "public"."break_glass_lock_admin_set"();
    IF NEW.approver_id IS NULL OR NOT "public"."break_glass_is_site_admin"(NEW.approver_id) THEN
      RAISE EXCEPTION 'only an active site admin can approve break-glass' USING ERRCODE = '42501';
    END IF;
    IF NEW.approver_id IS NOT DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'the subject of a break-glass request cannot approve it' USING ERRCODE = '42501';
    END IF;
    IF NEW.approver_id = OLD.admin_id THEN
      -- D10: a second Admin or the Owner approves "when one exists": another ACTIVE site admin.
      -- Only a single-active-admin site self-approves, and the grant is flagged. The other
      -- admins' rows are share-locked too (belt and braces with the admin-set lock).
      PERFORM 1 FROM "public"."site_roles" r JOIN "public"."users" u ON u.id = r.user_id
        WHERE r.user_id <> OLD.admin_id AND u.deactivated_at IS NULL
        FOR SHARE OF r, u;
      IF FOUND THEN
        RAISE EXCEPTION 'a second site admin must approve this request' USING ERRCODE = '42501';
      END IF;
      NEW.self_approved := true;
    ELSE
      NEW.self_approved := false;
    END IF;
    NEW.decided_at := now();
    NEW.decided_by := NEW.approver_id;
    NEW.starts_at := now();
    NEW.expires_at := now() + make_interval(mins => OLD.duration_minutes);
    NEW.ended_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.approver_id IS DISTINCT FROM OLD.approver_id OR NEW.self_approved <> OLD.self_approved
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'only an approval sets the approver and the window' USING ERRCODE = '55000';
  END IF;

  IF (OLD.status = 'pending' AND NEW.status IN ('denied', 'revoked'))
     OR (OLD.status = 'approved' AND NEW.status = 'revoked') THEN
    -- Denied by a site admin other than the requester; revoked (or withdrawn) by any site
    -- admin except the subject.
    IF NEW.decided_by IS NULL OR NOT "public"."break_glass_is_site_admin"(NEW.decided_by) THEN
      RAISE EXCEPTION 'only a site admin can deny or revoke break-glass' USING ERRCODE = '42501';
    END IF;
    IF NEW.decided_by IS NOT DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'the subject of a break-glass request cannot decide it' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'denied' AND NEW.decided_by = OLD.admin_id THEN
      RAISE EXCEPTION 'withdraw your own request instead of denying it' USING ERRCODE = '42501';
    END IF;
    NEW.decided_at := now();
    NEW.ended_at := now();
    RETURN NEW;
  END IF;

  IF NEW.status = 'expired' AND (
       (OLD.status = 'pending' AND now() >= OLD.request_expires_at)
       OR (OLD.status = 'approved' AND now() >= OLD.expires_at)) THEN
    IF OLD.status = 'pending' THEN NEW.decided_at := now(); END IF;
    NEW.decided_by := OLD.decided_by;
    NEW.ended_at := COALESCE(OLD.expires_at, now());
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'break-glass grant cannot go from % to %', OLD.status, NEW.status
    USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.break_glass_active_grant()
 RETURNS TABLE(team_id uuid, user_id uuid, thread_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT g.team_id, g.user_id, g.thread_id
  FROM "public"."break_glass_grants" g
  JOIN "public"."users" u ON u.id = g.admin_id AND u.deactivated_at IS NULL
  JOIN "public"."site_roles" r ON r.user_id = g.admin_id
  WHERE g.id = NULLIF(current_setting('kobe.break_glass_grant', true), '')::uuid
    AND g.admin_id = NULLIF(current_setting('kobe.break_glass_actor', true), '')::uuid
    AND g.status = 'approved'
    AND g.starts_at <= statement_timestamp() AND g.expires_at > statement_timestamp()
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.legal_hold_other_admin_exists(who uuid, subject uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  PERFORM 1 FROM "public"."site_roles" r JOIN "public"."users" u ON u.id = r.user_id
    WHERE r.user_id <> who AND r.user_id IS DISTINCT FROM subject AND u.deactivated_at IS NULL
    FOR SHARE OF r, u;
  RETURN FOUND;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.legal_holds_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Every hold starts as a pending request; the database stamps its time.
    IF NEW.status <> 'pending' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.self_approved OR NEW.closed_by IS NOT NULL OR NEW.closed_at IS NOT NULL
       OR NEW.release_requested_by IS NOT NULL OR NEW.release_requested_at IS NOT NULL
       OR NEW.release_reason IS NOT NULL OR NEW.released_by IS NOT NULL
       OR NEW.released_at IS NOT NULL OR NEW.release_self_approved THEN
      RAISE EXCEPTION 'legal holds start as pending requests' USING ERRCODE = '55000';
    END IF;
    IF NOT "public"."break_glass_is_site_admin"(NEW.placed_by) THEN
      RAISE EXCEPTION 'only a site admin can request a legal hold' USING ERRCODE = '42501';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;

  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  -- What was asked for never changes.
  IF (NEW.id, NEW.team_id, NEW.user_id, NEW.reason, NEW.placed_by, NEW.requested_at)
     IS DISTINCT FROM (OLD.id, OLD.team_id, OLD.user_id, OLD.reason, OLD.placed_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'a legal hold request cannot be changed' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'active' THEN
    IF (NEW.closed_by, NEW.closed_at, NEW.release_requested_by, NEW.release_requested_at,
        NEW.release_reason, NEW.released_by, NEW.released_at, NEW.release_self_approved)
       IS DISTINCT FROM (OLD.closed_by, OLD.closed_at, OLD.release_requested_by,
        OLD.release_requested_at, OLD.release_reason, OLD.released_by, OLD.released_at,
        OLD.release_self_approved) THEN
      RAISE EXCEPTION 'an approval only sets the approver' USING ERRCODE = '55000';
    END IF;
    PERFORM "public"."break_glass_lock_admin_set"();
    IF NEW.approved_by IS NULL OR NOT "public"."break_glass_is_site_admin"(NEW.approved_by) THEN
      RAISE EXCEPTION 'only an active site admin can approve a legal hold' USING ERRCODE = '42501';
    END IF;
    IF NEW.approved_by IS NOT DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'the subject of a legal hold cannot approve it' USING ERRCODE = '42501';
    END IF;
    IF NEW.approved_by = OLD.placed_by THEN
      -- D10 (as D18 requires): a second Admin or the Owner approves when an active one exists;
      -- only a single-active-admin site self-approves, flagged.
      IF "public"."legal_hold_other_admin_exists"(OLD.placed_by, OLD.user_id) THEN
        RAISE EXCEPTION 'a second site admin must approve this legal hold' USING ERRCODE = '42501';
      END IF;
      NEW.self_approved := true;
    ELSE
      NEW.self_approved := false;
    END IF;
    NEW.approved_at := now();
    -- Waits for purges in flight (they hold the lock shared); later purges see the hold.
    PERFORM pg_advisory_xact_lock(hashtextextended('kobe.legal_hold', 0));
    RETURN NEW;
  END IF;

  IF (NEW.approved_by, NEW.approved_at, NEW.self_approved)
     IS DISTINCT FROM (OLD.approved_by, OLD.approved_at, OLD.self_approved) THEN
    RAISE EXCEPTION 'only an approval sets the approver' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'pending' AND NEW.status IN ('denied', 'withdrawn') THEN
    IF (NEW.release_requested_by, NEW.release_requested_at, NEW.release_reason, NEW.released_by,
        NEW.released_at, NEW.release_self_approved)
       IS DISTINCT FROM (OLD.release_requested_by, OLD.release_requested_at, OLD.release_reason,
        OLD.released_by, OLD.released_at, OLD.release_self_approved) THEN
      RAISE EXCEPTION 'a pending legal hold has no release' USING ERRCODE = '55000';
    END IF;
    IF NEW.closed_by IS NULL OR NOT "public"."break_glass_is_site_admin"(NEW.closed_by) THEN
      RAISE EXCEPTION 'only a site admin can deny or withdraw a legal hold' USING ERRCODE = '42501';
    END IF;
    IF NEW.closed_by IS NOT DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'the subject of a legal hold cannot decide it' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'denied' AND NEW.closed_by = OLD.placed_by THEN
      RAISE EXCEPTION 'withdraw your own legal hold request instead of denying it' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'withdrawn' AND NEW.closed_by <> OLD.placed_by THEN
      RAISE EXCEPTION 'only the requester can withdraw a legal hold request' USING ERRCODE = '42501';
    END IF;
    NEW.closed_at := now();
    RETURN NEW;
  END IF;

  IF (NEW.closed_by, NEW.closed_at) IS DISTINCT FROM (OLD.closed_by, OLD.closed_at) THEN
    RAISE EXCEPTION 'only a denial or withdrawal closes a legal hold request' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'active' THEN
    IF (NEW.released_by, NEW.released_at, NEW.release_self_approved)
       IS DISTINCT FROM (OLD.released_by, OLD.released_at, OLD.release_self_approved) THEN
      RAISE EXCEPTION 'only a release approval sets the releaser' USING ERRCODE = '55000';
    END IF;
    IF OLD.release_requested_by IS NULL AND NEW.release_requested_by IS NOT NULL THEN
      IF NOT "public"."break_glass_is_site_admin"(NEW.release_requested_by) THEN
        RAISE EXCEPTION 'only a site admin can ask to release a legal hold' USING ERRCODE = '42501';
      END IF;
      IF NEW.release_requested_by IS NOT DISTINCT FROM OLD.user_id THEN
        RAISE EXCEPTION 'the subject of a legal hold cannot ask to release it' USING ERRCODE = '42501';
      END IF;
      NEW.release_requested_at := now();
      RETURN NEW;
    END IF;
    IF OLD.release_requested_by IS NOT NULL AND NEW.release_requested_by IS NULL
       AND NEW.release_requested_at IS NULL AND NEW.release_reason IS NULL THEN
      -- A cancelled release request (denied or withdrawn): the hold stays in force, the safe
      -- direction, so the database doesn't check who cancelled it (the audit event records it).
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a release request cannot be changed; cancel it and ask again' USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'released' THEN
    IF OLD.release_requested_by IS NULL
       OR (NEW.release_requested_by, NEW.release_requested_at, NEW.release_reason)
          IS DISTINCT FROM (OLD.release_requested_by, OLD.release_requested_at, OLD.release_reason) THEN
      RAISE EXCEPTION 'a legal hold is released only through an approved release request' USING ERRCODE = '55000';
    END IF;
    PERFORM "public"."break_glass_lock_admin_set"();
    IF NEW.released_by IS NULL OR NOT "public"."break_glass_is_site_admin"(NEW.released_by) THEN
      RAISE EXCEPTION 'only an active site admin can approve a release' USING ERRCODE = '42501';
    END IF;
    IF NEW.released_by IS NOT DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'the subject of a legal hold cannot release it' USING ERRCODE = '42501';
    END IF;
    IF NEW.released_by = OLD.release_requested_by THEN
      IF "public"."legal_hold_other_admin_exists"(OLD.release_requested_by, OLD.user_id) THEN
        RAISE EXCEPTION 'a second site admin must approve this release' USING ERRCODE = '42501';
      END IF;
      NEW.release_self_approved := true;
    ELSE
      NEW.release_self_approved := false;
    END IF;
    NEW.released_at := now();
    -- The audit IP erasure sweep moved past the rows this hold kept: start it over (KOBE-17).
    -- Exclusive hold lock first: a sweep in flight (it holds the lock shared while it reads and
    -- writes its position) commits before this reset, so the reset always wins (review N2).
    PERFORM pg_advisory_xact_lock(hashtextextended('kobe.legal_hold', 0));
    INSERT INTO "public"."site_settings" (key, value) VALUES ('audit.pii_sweep_seq', '0')
      ON CONFLICT (key) DO UPDATE SET value = '0', updated_at = now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'legal hold cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.audit_pii_retention_hours()
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE((
    SELECT CASE WHEN s.value ~ '^[0-9]{1,6}$' THEN LEAST(GREATEST(s.value::integer, 1), 8760) END
    FROM "public"."site_settings" s WHERE s.key = 'audit.pii_retention_hours'), 12)
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.kobe_count_model_spend()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  INSERT INTO "model_spend_daily" ("team_id", "day", "user_id", "cost_usd", "tokens", "calls")
  SELECT "team_id", ("at" AT TIME ZONE 'UTC')::date, "user_id", COALESCE(sum("cost_usd"), 0),
         sum("input_tokens"::bigint + "output_tokens" + "cache_read_tokens" + "cache_write_tokens"), count(*)
    FROM "new_rows" GROUP BY 1, 2, 3
  ON CONFLICT ("team_id", "day", "user_id") DO UPDATE
    SET "cost_usd" = "model_spend_daily"."cost_usd" + EXCLUDED."cost_usd",
        "tokens" = "model_spend_daily"."tokens" + EXCLUDED."tokens",
        "calls" = "model_spend_daily"."calls" + EXCLUDED."calls";
  INSERT INTO "site_model_spend_daily" ("day", "cost_usd", "tokens")
  SELECT ("at" AT TIME ZONE 'UTC')::date, COALESCE(sum("cost_usd"), 0), sum("input_tokens"::bigint + "output_tokens" + "cache_read_tokens" + "cache_write_tokens")
    FROM "new_rows" GROUP BY 1
  ON CONFLICT ("day") DO UPDATE
    SET "cost_usd" = "site_model_spend_daily"."cost_usd" + EXCLUDED."cost_usd",
        "tokens" = "site_model_spend_daily"."tokens" + EXCLUDED."tokens";
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.kobe_budget_alert_verify()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  today date := (now() AT TIME ZONE 'UTC')::date;
  start date;
  configured numeric;
  actual numeric;
  own boolean;
BEGIN
  start := CASE NEW.period WHEN 'month' THEN date_trunc('month', today)::date ELSE today END;
  IF NEW.period_start IS DISTINCT FROM start THEN
    RAISE EXCEPTION 'budget alert: not the current period' USING ERRCODE = '23514';
  END IF;
  IF NEW.scope = 'site' THEN
    SELECT CASE WHEN NEW.unit = 'usd' THEN
                  CASE WHEN NEW.period = 'month' THEN l.monthly_usd ELSE l.daily_usd END
                ELSE CASE WHEN NEW.period = 'month' THEN l.monthly_tokens ELSE l.daily_tokens END END
      INTO configured FROM "site_model_limits" l WHERE l.id = 1;
    SELECT COALESCE(sum(CASE WHEN NEW.unit = 'usd' THEN s.cost_usd ELSE s.tokens END), 0)
      INTO actual FROM "site_model_spend_daily" s WHERE s.day BETWEEN start AND today;
  ELSE
    IF NEW.team_id IS DISTINCT FROM NULLIF(current_setting('kobe.team_id', true), '')::uuid THEN
      RAISE EXCEPTION 'budget alert: outside its team' USING ERRCODE = '42501';
    END IF;
    IF NEW.scope = 'user' THEN
      IF NEW.user_id IS NULL OR NOT EXISTS (SELECT 1 FROM "team_members" m
                                             WHERE m.team_id = NEW.team_id
                                               AND m.user_id = NEW.user_id) THEN
        RAISE EXCEPTION 'budget alert: not a member of the team' USING ERRCODE = '23514';
      END IF;
      SELECT EXISTS (SELECT 1 FROM "team_budgets" b
                      WHERE b.team_id = NEW.team_id AND b.user_id = NEW.user_id) INTO own;
    END IF;
    SELECT CASE
             WHEN NEW.scope = 'user' AND NOT own THEN
               CASE WHEN NEW.unit = 'usd' THEN
                      CASE WHEN NEW.period = 'month' THEN b.member_monthly_usd ELSE b.member_daily_usd END
                    ELSE CASE WHEN NEW.period = 'month' THEN b.member_monthly_tokens ELSE b.member_daily_tokens END END
             ELSE
               CASE WHEN NEW.unit = 'usd' THEN
                      CASE WHEN NEW.period = 'month' THEN b.monthly_usd ELSE b.daily_usd END
                    ELSE CASE WHEN NEW.period = 'month' THEN b.monthly_tokens ELSE b.daily_tokens END END
           END
      INTO configured
      FROM "team_budgets" b
     WHERE b.team_id = NEW.team_id
       AND b.user_id IS NOT DISTINCT FROM
           (CASE WHEN NEW.scope = 'user' AND own THEN NEW.user_id END);
    SELECT COALESCE(sum(CASE WHEN NEW.unit = 'usd' THEN s.cost_usd ELSE s.tokens END), 0)
      INTO actual FROM "model_spend_daily" s
     WHERE s.team_id = NEW.team_id AND s.day BETWEEN start AND today
       AND (NEW.scope = 'team' OR s.user_id = NEW.user_id);
  END IF;
  IF configured IS NULL OR NEW.limit_amount IS DISTINCT FROM configured THEN
    RAISE EXCEPTION 'budget alert: no such budget' USING ERRCODE = '23514';
  END IF;
  NEW.spent_amount := actual;
  NEW.created_at := now();
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.kobe_budget_alert_emails()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.scope = 'site' THEN
    INSERT INTO "budget_alert_emails" ("alert_id", "recipient_id")
    SELECT NEW.id, r.user_id FROM "site_roles" r JOIN "users" u ON u.id = r.user_id
     WHERE u.deactivated_at IS NULL
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO "budget_alert_emails" ("alert_id", "recipient_id")
    SELECT NEW.id, m.user_id FROM "team_members" m JOIN "users" u ON u.id = m.user_id
     WHERE m.team_id = NEW.team_id AND m.role = 'team_admin' AND u.deactivated_at IS NULL
    UNION
    SELECT NEW.id, u.id FROM "users" u
     WHERE NEW.scope = 'user' AND u.id = NEW.user_id AND u.deactivated_at IS NULL
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.kobe_site_limits_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "site_roles" r JOIN "users" u ON u.id = r.user_id
                  WHERE r.user_id = NEW.updated_by AND u.deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'site limits are changed by a site admin' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.skill_versions_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'uploaded skill versions are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  -- Nested: PL/pgSQL may evaluate both operands, and site versions have no team_id.
  IF TG_TABLE_NAME = 'team_skill_versions' THEN
    IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'uploaded skill versions are immutable' USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.kobe_reserve_budget(p_team uuid, p_user uuid, p_call text, p_usd numeric, p_tokens bigint, p_ttl_ms integer, p_member_share numeric, p_lines jsonb, p_salt text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  cur text := NULLIF(current_setting('kobe.team_id', true), '');
  expiry timestamptz := clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0);
  has_site boolean;
  v_team_key text := encode(sha256(convert_to(p_salt || ':team:' || p_team::text, 'utf8')), 'hex');
  v_member_key text := encode(sha256(convert_to(p_salt || ':member:' || p_team::text || ':' || p_user::text, 'utf8')), 'hex');
  n integer := jsonb_array_length(p_lines);
  i integer;
  line jsonb;
  unit_usd boolean;
  lim numeric;
  spent numeric;
  cost numeric;
  share numeric;
  self_key text;
  total numeric;
  own numeric;
  others boolean;
BEGIN
  IF cur IS NOT NULL AND cur <> p_team::text THEN
    RAISE EXCEPTION 'kobe_reserve_budget: another team is in force' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('kobe.team_id', p_team::text, true);
  has_site := EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE l->>'scope' IN ('site', 'install'));
  PERFORM pg_advisory_xact_lock(hashtextextended('kobe.budget:team:' || p_team::text, 0));
  IF has_site THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('kobe.budget:site', 0));
  END IF;
  -- The sweep: rows long expired (a minute past their expiry; they never counted) are removed here,
  -- under the locks, so no separate sweeper is needed. The site-wide rows of every team go too.
  DELETE FROM "budget_reservations"
    WHERE team_id = p_team AND expires_at <= clock_timestamp() - interval '1 minute';
  IF has_site THEN
    DELETE FROM "site_budget_reservations"
      WHERE expires_at <= clock_timestamp() - interval '1 minute';
  END IF;
  FOR i IN 0 .. n - 1 LOOP
    line := p_lines -> i;
    unit_usd := line->>'unit' = 'usd';
    lim := (line->>'limit')::numeric;
    spent := (line->>'spent')::numeric;
    cost := CASE WHEN unit_usd THEN p_usd ELSE p_tokens END;
    share := CASE WHEN line->>'scope' = 'user' THEN 'Infinity'::numeric
                  ELSE greatest(0, lim - spent) * p_member_share END;
    self_key := CASE WHEN line->>'scope' IN ('site', 'install') THEN v_member_key
                     ELSE p_user::text END;
    SELECT COALESCE(sum(least(m.amt, share)), 0),
           COALESCE(sum(m.amt) FILTER (WHERE m.member = self_key), 0),
           COALESCE(bool_or(m.member <> self_key), false)
      INTO total, own, others
      FROM (
        SELECT r.member, sum(r.amt) AS amt FROM (
          SELECT user_id::text AS member, CASE WHEN unit_usd THEN usd ELSE tokens::numeric END AS amt
            FROM "budget_reservations"
            WHERE line->>'scope' IN ('team', 'user') AND team_id = p_team
              AND (line->>'scope' = 'team' OR user_id = p_user)
              AND expires_at > clock_timestamp() AND call_id <> p_call
          UNION ALL
          SELECT member_key, CASE WHEN unit_usd THEN usd ELSE tokens::numeric END
            FROM "site_budget_reservations"
            WHERE line->>'scope' IN ('site', 'install')
              AND expires_at > clock_timestamp() AND NOT (team_key = v_team_key AND call_id = p_call)
        ) r GROUP BY r.member
      ) m;
    IF spent + total >= lim THEN
      RETURN 'full:' || i;
    END IF;
    IF (own > 0 OR others) AND own + cost > share THEN
      RETURN 'own_share:' || i;
    END IF;
  END LOOP;
  INSERT INTO "budget_reservations" ("team_id", "call_id", "user_id", "usd", "tokens", "expires_at")
    VALUES (p_team, p_call, p_user, p_usd, p_tokens, expiry)
    ON CONFLICT ("team_id", "call_id") DO UPDATE
      SET "usd" = EXCLUDED."usd", "tokens" = EXCLUDED."tokens", "expires_at" = EXCLUDED."expires_at";
  IF has_site THEN
    INSERT INTO "site_budget_reservations" ("team_key", "call_id", "member_key", "usd", "tokens", "expires_at")
      VALUES (v_team_key, p_call, v_member_key, p_usd, p_tokens, expiry)
      ON CONFLICT ("team_key", "call_id") DO UPDATE
        SET "usd" = EXCLUDED."usd", "tokens" = EXCLUDED."tokens", "expires_at" = EXCLUDED."expires_at";
  END IF;
  RETURN 'ok';
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.kobe_settle_budget(p_team uuid, p_calls text[], p_keep_ms integer, p_salt text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  cur text := NULLIF(current_setting('kobe.team_id', true), '');
  keep timestamptz := clock_timestamp() + make_interval(secs => COALESCE(p_keep_ms, 0) / 1000.0);
  tkey text := encode(sha256(convert_to(p_salt || ':team:' || p_team::text, 'utf8')), 'hex');
  n integer;
BEGIN
  IF cur IS NOT NULL AND cur <> p_team::text THEN
    RAISE EXCEPTION 'kobe_settle_budget: another team is in force' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('kobe.team_id', p_team::text, true);
  IF p_keep_ms IS NULL THEN
    DELETE FROM "site_budget_reservations" WHERE team_key = tkey AND call_id = ANY (p_calls);
    DELETE FROM "budget_reservations" WHERE team_id = p_team AND call_id = ANY (p_calls);
  ELSE
    UPDATE "site_budget_reservations" SET expires_at = least(expires_at, keep)
      WHERE team_key = tkey AND call_id = ANY (p_calls);
    UPDATE "budget_reservations" SET expires_at = least(expires_at, keep)
      WHERE team_id = p_team AND call_id = ANY (p_calls);
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.kobe_extend_budget(p_team uuid, p_calls text[], p_ttl_ms integer, p_salt text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  cur text := NULLIF(current_setting('kobe.team_id', true), '');
  expiry timestamptz := clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0);
  tkey text := encode(sha256(convert_to(p_salt || ':team:' || p_team::text, 'utf8')), 'hex');
  n integer;
BEGIN
  IF cur IS NOT NULL AND cur <> p_team::text THEN
    RAISE EXCEPTION 'kobe_extend_budget: another team is in force' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('kobe.team_id', p_team::text, true);
  UPDATE "site_budget_reservations" SET expires_at = greatest(expires_at, expiry)
    WHERE team_key = tkey AND call_id = ANY (p_calls) AND expires_at > clock_timestamp();
  UPDATE "budget_reservations" SET expires_at = greatest(expires_at, expiry)
    WHERE team_id = p_team AND call_id = ANY (p_calls) AND expires_at > clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;
--> statement-breakpoint
-- Stored values of small site tables move to the new names: the site's budget alerts (scope) and
-- break-glass notifications to site admins (recipient_role). Both checks are swapped around it.
ALTER TABLE "budget_alerts" DROP CONSTRAINT "budget_alerts_scope";--> statement-breakpoint
ALTER TABLE "budget_alerts" DROP CONSTRAINT "budget_alerts_subject";--> statement-breakpoint
UPDATE "budget_alerts" SET "scope" = 'site' WHERE "scope" = 'install';--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_scope" CHECK ("budget_alerts"."scope" IN ('site', 'team', 'user'));--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_subject" CHECK (("budget_alerts"."scope" = 'site' AND "budget_alerts"."team_id" IS NULL AND "budget_alerts"."user_id" IS NULL)
        OR ("budget_alerts"."scope" = 'team' AND "budget_alerts"."team_id" IS NOT NULL AND "budget_alerts"."user_id" IS NULL)
        OR ("budget_alerts"."scope" = 'user' AND "budget_alerts"."team_id" IS NOT NULL AND "budget_alerts"."user_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "break_glass_notifications" DROP CONSTRAINT "break_glass_notifications_role";--> statement-breakpoint
UPDATE "break_glass_notifications" SET "recipient_role" = 'site_admin' WHERE "recipient_role" = 'install_admin';--> statement-breakpoint
ALTER TABLE "break_glass_notifications" ADD CONSTRAINT "break_glass_notifications_role" CHECK ("break_glass_notifications"."recipient_role" IN ('site_admin', 'team_admin', 'subject', 'requester'));--> statement-breakpoint
-- Runs are history and can be large: their stop scope is not rewritten. The check now also admits
-- 'site' (new stops); 'install' stays valid on runs stopped before. NOT VALID skips a scan of runs:
-- the check only widens, so every existing row already satisfies it.
ALTER TABLE "runs" DROP CONSTRAINT "runs_budget_stop_scope";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_budget_stop_scope" CHECK ("runs"."budget_stop_scope" IS NULL OR "runs"."budget_stop_scope" IN ('site', 'install', 'team', 'user')) NOT VALID;
