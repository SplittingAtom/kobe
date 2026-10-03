-- Legal hold in Postgres (spec D18, KOBE-17): the allowed transitions, and the two-person rule over
-- the user ids written (placed_by, approved_by, release_requested_by, released_by must be distinct
-- active install admins, unless only one exists), are checked for every writer. Those ids are
-- asserted by the writer, not authenticated: the app role could name another admin (as for
-- break-glass approvers); the session-bound server is what authenticates them. Purges are ordered
-- against approvals by an advisory lock, and deleting, re-owning or truncating held threads fails
-- (a backstop for purge jobs that forget to check). Everything is SECURITY INVOKER (the default;
-- the catalog check forbids DEFINER).

-- Purges take this lock shared before they check for holds; an approval takes it exclusively. A
-- purge that started before an approval finishes first; one that starts after sees the hold.
CREATE FUNCTION "public"."legal_hold_lock_shared"() RETURNS void
  LANGUAGE sql SET search_path = pg_catalog, public AS $$
  SELECT pg_advisory_xact_lock_shared(hashtextextended('kobe.legal_hold', 0))
$$;--> statement-breakpoint

-- Whether an active hold covers `subject`'s data in `team`: a team-wide hold, or a hold on that
-- user in that team. With a NULL subject only a team-wide hold counts (use isUnderLegalHold() in
-- the app for "any hold in this team"). For purge queries: WHERE NOT legal_hold_covers(...).
CREATE FUNCTION "public"."legal_hold_covers"(team uuid, subject uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."legal_holds" h
    WHERE h.status = 'active' AND h.team_id = team
      AND (h.user_id IS NULL OR h.user_id = subject))
$$;--> statement-breakpoint

-- Whether an active install admin other than `who` and other than the held user exists (D10:
-- then the requester can't approve). The held user never counts: they can't approve, so a hold on
-- the only other admin is self-approved (flagged) instead of waiting forever. Share-locks those
-- admins' rows; callers hold the admin-set lock (break_glass_lock_admin_set).
CREATE FUNCTION "public"."legal_hold_other_admin_exists"(who uuid, subject uuid) RETURNS boolean
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM "public"."install_roles" r JOIN "public"."users" u ON u.id = r.user_id
    WHERE r.user_id <> who AND r.user_id IS DISTINCT FROM subject AND u.deactivated_at IS NULL
    FOR SHARE OF r, u;
  RETURN FOUND;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "public"."legal_holds_guard"() RETURNS trigger
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
    IF NOT "public"."break_glass_is_install_admin"(NEW.placed_by) THEN
      RAISE EXCEPTION 'only an install admin can request a legal hold' USING ERRCODE = '42501';
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
    IF NEW.approved_by IS NULL OR NOT "public"."break_glass_is_install_admin"(NEW.approved_by) THEN
      RAISE EXCEPTION 'only an active install admin can approve a legal hold' USING ERRCODE = '42501';
    END IF;
    IF NEW.approved_by IS NOT DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'the subject of a legal hold cannot approve it' USING ERRCODE = '42501';
    END IF;
    IF NEW.approved_by = OLD.placed_by THEN
      -- D10 (as D18 requires): a second Admin or the Owner approves when an active one exists;
      -- only a single-active-admin install self-approves, flagged.
      IF "public"."legal_hold_other_admin_exists"(OLD.placed_by, OLD.user_id) THEN
        RAISE EXCEPTION 'a second install admin must approve this legal hold' USING ERRCODE = '42501';
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
    IF NEW.closed_by IS NULL OR NOT "public"."break_glass_is_install_admin"(NEW.closed_by) THEN
      RAISE EXCEPTION 'only an install admin can deny or withdraw a legal hold' USING ERRCODE = '42501';
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
      IF NOT "public"."break_glass_is_install_admin"(NEW.release_requested_by) THEN
        RAISE EXCEPTION 'only an install admin can ask to release a legal hold' USING ERRCODE = '42501';
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
    IF NEW.released_by IS NULL OR NOT "public"."break_glass_is_install_admin"(NEW.released_by) THEN
      RAISE EXCEPTION 'only an active install admin can approve a release' USING ERRCODE = '42501';
    END IF;
    IF NEW.released_by IS NOT DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'the subject of a legal hold cannot release it' USING ERRCODE = '42501';
    END IF;
    IF NEW.released_by = OLD.release_requested_by THEN
      IF "public"."legal_hold_other_admin_exists"(OLD.release_requested_by, OLD.user_id) THEN
        RAISE EXCEPTION 'a second install admin must approve this release' USING ERRCODE = '42501';
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
    INSERT INTO "public"."install_settings" (key, value) VALUES ('audit.pii_sweep_seq', '0')
      ON CONFLICT (key) DO UPDATE SET value = '0', updated_at = now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'legal hold cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "legal_holds_guard" BEFORE INSERT OR UPDATE ON "legal_holds"
  FOR EACH ROW EXECUTE FUNCTION "public"."legal_holds_guard"();--> statement-breakpoint

-- Backstop: purge jobs must skip held data (legal_hold_covers / isUnderLegalHold); deleting a held
-- thread fails with SQLSTATE KH001 instead of losing it. Moving a thread to Trash is an UPDATE and
-- stays allowed.
CREATE FUNCTION "public"."threads_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF "public"."legal_hold_covers"(OLD.team_id, OLD.owner_user_id) THEN
    RAISE EXCEPTION 'thread % is under legal hold and cannot be deleted', OLD.id
      USING ERRCODE = 'KH001';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "threads_legal_hold" BEFORE DELETE ON "threads"
  FOR EACH ROW EXECUTE FUNCTION "public"."threads_legal_hold_guard"();--> statement-breakpoint

-- Entries are deleted in bulk: one check per statement over the distinct threads deleted from.
-- A thread already gone (deleted in the same statement by cascade) counts for team-wide holds.
CREATE FUNCTION "public"."thread_entries_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.thread_id FROM gone d) g
    LEFT JOIN "public"."threads" t ON t.team_id = g.team_id AND t.id = g.thread_id
    WHERE "public"."legal_hold_covers"(g.team_id, t.owner_user_id)) THEN
    RAISE EXCEPTION 'thread entries under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "thread_entries_legal_hold" AFTER DELETE ON "thread_entries"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."thread_entries_legal_hold_guard"();
--> statement-breakpoint

-- Moving a held thread to another owner (or team) would let a purge delete it afterwards: refused
-- while the hold covers it (KOBE-17 review M2).
CREATE FUNCTION "public"."threads_legal_hold_keep_owner"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.team_id, NEW.owner_user_id) IS DISTINCT FROM (OLD.team_id, OLD.owner_user_id) THEN
    PERFORM "public"."legal_hold_lock_shared"();
    IF "public"."legal_hold_covers"(OLD.team_id, OLD.owner_user_id) THEN
      RAISE EXCEPTION 'thread % is under legal hold; its owner and team cannot change', OLD.id
        USING ERRCODE = 'KH001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "threads_legal_hold_owner" BEFORE UPDATE OF "team_id", "owner_user_id" ON "threads"
  FOR EACH ROW EXECUTE FUNCTION "public"."threads_legal_hold_keep_owner"();--> statement-breakpoint

-- TRUNCATE skips row triggers: refused on held tables while any hold is active (the app role has
-- no TRUNCATE privilege; this binds the owner too).
CREATE FUNCTION "public"."legal_hold_refuse_truncate"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (SELECT 1 FROM "public"."legal_holds" h WHERE h.status = 'active') THEN
    RAISE EXCEPTION '% cannot be truncated while a legal hold is active', TG_TABLE_NAME
      USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "threads_legal_hold_truncate" BEFORE TRUNCATE ON "threads"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint
CREATE TRIGGER "thread_entries_legal_hold_truncate" BEFORE TRUNCATE ON "thread_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();
