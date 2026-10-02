-- Append-only audit log (KOBE-15, spec D6/D31). Three layers:
--   1. Grants (tenancy registry): the app role holds INSERT and SELECT only.
--   2. Triggers below refuse UPDATE, DELETE and TRUNCATE for every role they fire for (the owner
--      too; only a superuser or a role that drops/disables the triggers gets past them).
--   3. A SHA-256 hash chain over gapless seq numbers, so that a privileged change that gets past
--      1 and 2 (an edited, deleted or inserted row) is detectable: verifyAuditChain() recomputes it,
--      and the head hash can be anchored outside the database (audit export / SIEM, KOBE-19).
-- Every function is SECURITY INVOKER (the default): it runs with the caller's privileges.

-- Canonical text of a row, the input of its hash. jsonb output is deterministic (normalized key
-- order and numbers); `at` is rendered in UTC with microseconds, independent of the session's
-- TimeZone. Changing this function invalidates every stored hash: version it (kobe.audit.v2).
CREATE FUNCTION "public"."audit_log_canonical"(r "public"."audit_log") RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT 'kobe.audit.v1' || chr(10) || r.prev_hash || chr(10) || jsonb_build_array(
    r.seq, r.id, to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), r.team_id,
    r.actor_kind::text, r.actor_id, r.action, r.target, host(r.ip), r.user_agent
  )::text
$$;--> statement-breakpoint

-- Assigns seq, at, prev_hash and hash. The transaction-scoped advisory lock serializes appends
-- until commit, so seq is gapless and commits in seq order: a reader that has seen seq n has seen
-- every seq < n. A rolled-back append leaves no gap. Each query in this (volatile) function takes
-- a fresh snapshot under READ COMMITTED, so the head read after the lock is the committed head;
-- under REPEATABLE READ a stale head yields a duplicate seq and the insert fails (never a fork).
-- Keep audited transactions short and append last: the lock is held until commit.
CREATE FUNCTION "public"."audit_log_append"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  active_team uuid := NULLIF(current_setting('kobe.team_id', true), '')::uuid;
  head record;
BEGIN
  IF NEW.seq <> 0 OR NEW.prev_hash <> '' OR NEW.hash <> '' THEN
    RAISE EXCEPTION 'audit_log.seq, prev_hash and hash are assigned by the database; omit them'
      USING ERRCODE = '428C9';
  END IF;
  -- Inside withTeam(), an event may only belong to the active team (or to no team).
  IF active_team IS NOT NULL AND NEW.team_id IS NOT NULL AND NEW.team_id <> active_team THEN
    RAISE EXCEPTION 'audit event for team % written in the context of another team', NEW.team_id
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('kobe.audit_log', 0));
  SELECT a.seq, a.hash INTO head FROM "public"."audit_log" a ORDER BY a.seq DESC LIMIT 1;
  NEW.seq := coalesce(head.seq, 0) + 1;
  NEW.prev_hash := coalesce(head.hash, repeat('0', 64));
  NEW.at := clock_timestamp();
  NEW.hash := encode(sha256(convert_to("public"."audit_log_canonical"(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_log_append" BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "public"."audit_log_append"();--> statement-breakpoint

CREATE FUNCTION "public"."audit_log_refuse_change"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_log_refuse_update_delete" BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "public"."audit_log_refuse_change"();--> statement-breakpoint
CREATE TRIGGER "audit_log_refuse_truncate" BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."audit_log_refuse_change"();
