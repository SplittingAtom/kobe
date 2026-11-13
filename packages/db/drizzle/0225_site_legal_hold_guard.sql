-- KOBE-647 (v1.3 Semantic Memory SMA11a, SM28): the rules of the Site-wide legal hold (0224) and its
-- guards on the Site memory tables. Custom, so db:rebase keeps this SQL as written.
--
-- site_legal_holds follows legal_holds' lifecycle and D10's two-person rule (0033, as renamed by
-- 0091): every hold starts as a pending request by an active site admin; a second active site admin
-- approves (a single-active-admin site self-approves, flagged), the requester withdraws or another
-- admin denies; a release is a request plus a second admin's approval. There is no subject user,
-- so the subject checks of legal_holds_guard() fall away. The approval takes the hold lock
-- exclusively (same key as legal_holds), so it waits for purges in flight and later purges see it.
-- legal_holds_guard() itself is untouched: no existing hold check changes meaning.
--
-- While any Site hold is active, deleting Site items or versions fails with KH001: purges, the
-- version cap's pruning (0222) and the cascade from an item delete alike. Archiving and superseding
-- are UPDATEs and stay allowed; versions stay immutable (0222). TRUNCATE of either Site table is
-- refused too (a backstop for the owner; the app role has no TRUNCATE). Run records of the Site
-- lane (run_site_memory_items) are Workspace data: they go with their run under the Workspace's
-- holds (0217), and the only Site-side path that removes them, an item or version delete, is
-- refused here in the same statement. Everything is SECURITY INVOKER with a pinned search_path.

CREATE FUNCTION "public"."site_legal_hold_active"() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM "public"."site_legal_holds" h WHERE h.status = 'active')
$$;--> statement-breakpoint

CREATE FUNCTION "public"."site_legal_holds_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
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
  IF (NEW.id, NEW.reason, NEW.placed_by, NEW.requested_at)
     IS DISTINCT FROM (OLD.id, OLD.reason, OLD.placed_by, OLD.requested_at) THEN
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
    IF NEW.approved_by = OLD.placed_by THEN
      -- D10: a second admin approves when an active one exists; only a single-active-admin site
      -- self-approves, flagged.
      IF "public"."legal_hold_other_admin_exists"(OLD.placed_by, NULL) THEN
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
    IF NEW.released_by = OLD.release_requested_by THEN
      IF "public"."legal_hold_other_admin_exists"(OLD.release_requested_by, NULL) THEN
        RAISE EXCEPTION 'a second site admin must approve this release' USING ERRCODE = '42501';
      END IF;
      NEW.release_self_approved := true;
    ELSE
      NEW.release_self_approved := false;
    END IF;
    NEW.released_at := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'legal hold cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "site_legal_holds_guard" BEFORE INSERT OR UPDATE ON "site_legal_holds"
  FOR EACH ROW EXECUTE FUNCTION "public"."site_legal_holds_guard"();--> statement-breakpoint

-- Deleting any Site item or version while a Site hold is active fails (KH001). The hold lock is
-- taken shared first, as every purge does (legal_hold_lock_shared, 0033).
CREATE FUNCTION "public"."site_memory_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM gone) THEN
    PERFORM "public"."legal_hold_lock_shared"();
    IF "public"."site_legal_hold_active"() THEN
      RAISE EXCEPTION 'Site memory under legal hold cannot be deleted' USING ERRCODE = 'KH001';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "site_memory_items_legal_hold" AFTER DELETE ON "site_memory_items"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."site_memory_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "site_memory_item_versions_legal_hold" AFTER DELETE ON "site_memory_item_versions"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."site_memory_legal_hold_guard"();--> statement-breakpoint

CREATE FUNCTION "public"."site_legal_hold_refuse_truncate"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF "public"."site_legal_hold_active"() THEN
    RAISE EXCEPTION '% cannot be truncated while a Site legal hold is active', TG_TABLE_NAME
      USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "site_memory_items_legal_hold_truncate" BEFORE TRUNCATE ON "site_memory_items"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."site_legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "site_memory_item_versions_legal_hold_truncate" BEFORE TRUNCATE ON "site_memory_item_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."site_legal_hold_refuse_truncate"();
