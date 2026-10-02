-- Break-glass in Postgres (spec D10, KOBE-16): the two-person rule, the approver's role, the time
-- box and the allowed status transitions hold for every writer, not only the server's code paths.
-- SECURITY INVOKER (the default; the catalog check forbids DEFINER): the checks read users and
-- install_roles with the app role's own SELECT privilege.

-- An active (not deactivated) Owner or Admin.
CREATE FUNCTION "public"."break_glass_is_install_admin"(who uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."install_roles" r JOIN "public"."users" u ON u.id = r.user_id
    WHERE r.user_id = who AND u.deactivated_at IS NULL)
$$;--> statement-breakpoint

CREATE FUNCTION "public"."break_glass_grants_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Every grant starts as a pending request; the database stamps its times.
    IF NEW.status <> 'pending' OR NEW.approver_id IS NOT NULL OR NEW.self_approved
       OR NEW.decided_at IS NOT NULL OR NEW.decided_by IS NOT NULL OR NEW.starts_at IS NOT NULL
       OR NEW.expires_at IS NOT NULL OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'break-glass grants start as pending requests' USING ERRCODE = '55000';
    END IF;
    IF NOT "public"."break_glass_is_install_admin"(NEW.admin_id) THEN
      RAISE EXCEPTION 'only an install admin can request break-glass' USING ERRCODE = '42501';
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
    IF NEW.approver_id IS NULL OR NOT "public"."break_glass_is_install_admin"(NEW.approver_id) THEN
      RAISE EXCEPTION 'only an install admin can approve break-glass' USING ERRCODE = '42501';
    END IF;
    IF NEW.approver_id IS NOT DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'the subject of a break-glass request cannot approve it' USING ERRCODE = '42501';
    END IF;
    IF NEW.approver_id = OLD.admin_id THEN
      -- D10: a second Admin or the Owner approves when one exists; only a single-admin install
      -- self-approves, and the grant is flagged. Any other install role counts, deactivated or
      -- not: deactivating the only other admin must not unlock self-approval. The rows are
      -- share-locked so a concurrent demotion waits for this approval.
      PERFORM 1 FROM "public"."install_roles" r WHERE r.user_id <> OLD.admin_id FOR SHARE;
      IF FOUND THEN
        RAISE EXCEPTION 'a second install admin must approve this request' USING ERRCODE = '42501';
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
    -- Denied by an install admin other than the requester; revoked (or withdrawn) by any install
    -- admin except the subject.
    IF NEW.decided_by IS NULL OR NOT "public"."break_glass_is_install_admin"(NEW.decided_by) THEN
      RAISE EXCEPTION 'only an install admin can deny or revoke break-glass' USING ERRCODE = '42501';
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
$$;--> statement-breakpoint

CREATE TRIGGER "break_glass_grants_guard" BEFORE INSERT OR UPDATE ON "break_glass_grants"
  FOR EACH ROW EXECUTE FUNCTION "public"."break_glass_grants_guard"();
