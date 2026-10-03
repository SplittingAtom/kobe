-- Audit chain v2 (KOBE-17; user decision 2026-10-03): the client IP and user agent of each audit
-- row are erased after a configurable period, and the chain must still verify. Design and review:
-- docs/audit-log.md ("IP and user agent") and docs/ledger/KOBE-17.md.
--
--   * v2 rows hash a salted commitment to (id, IP, user agent) instead of the raw values, so the
--     values and the salt can be nulled later without touching the hash. While present, the values
--     are checked against the commitment; once the salt is gone the commitment reveals nothing.
--   * v1 rows (chained before this migration; hash_version NULL) keep their stored hashes, so every
--     head already anchored off the box stays valid. The server verifies them after the upgrade and
--     appends `audit.chain.upgraded` with a seal over all of them; a v1 row may be erased only once
--     that seal is 24 hours old, and is then verified through the seal.
--   * The app role may erase (column grants on ip, user_agent, pii_salt); the update trigger allows
--     nothing else, only for rows older than the configured period and not under a legal hold.
--
-- This migration changes no row and scans no table (all pending migrations run in one
-- transaction, holding audit_log's ACCESS EXCLUSIVE lock from the ADD COLUMNs of the previous one
-- to COMMIT): new columns are nullable without defaults, constraints are NOT VALID (every existing
-- row satisfies them by construction; new and changed rows are checked), no index is built, and the
-- seal is computed later by the server. Lock window: constant, independent of the log's size.
-- Every function is SECURITY INVOKER (the default).

CREATE FUNCTION "public"."audit_log_digest"(input text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(input, 'UTF8')), 'hex')
$$;--> statement-breakpoint

-- v1 canonical form (KOBE-15), unchanged: covers the raw IP and user agent.
CREATE FUNCTION "public"."audit_log_canonical_v1"(r "public"."audit_log") RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT 'kobe.audit.v1' || chr(10) || r.prev_hash || chr(10) || jsonb_build_array(
    r.seq, r.id, to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), r.team_id,
    r.actor_kind::text, r.actor_id, r.action, r.target, host(r.ip), r.user_agent
  )::text
$$;--> statement-breakpoint

-- v2 canonical form: the commitment instead of the IP and user agent. Also the "v2 view" of a v1
-- row in the upgrade seal (its commitment is always NULL). Changing it invalidates every v2 hash:
-- version it (kobe.audit.v3).
CREATE FUNCTION "public"."audit_log_canonical_v2"(r "public"."audit_log") RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT 'kobe.audit.v2' || chr(10) || r.prev_hash || chr(10) || jsonb_build_array(
    r.seq, r.id, to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), r.team_id,
    r.actor_kind::text, r.actor_id, r.action, r.target, r.pii_commitment
  )::text
$$;--> statement-breakpoint

-- The input of a row's hash, by version. Older releases hash this function's output, so they keep
-- verifying v2 rows during a rolling upgrade.
CREATE OR REPLACE FUNCTION "public"."audit_log_canonical"(r "public"."audit_log") RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN r.hash_version IS NULL THEN "public"."audit_log_canonical_v1"(r)
              ELSE "public"."audit_log_canonical_v2"(r) END
$$;--> statement-breakpoint

-- Input of pii_commitment: salt, row id (binds the values to this row), IP and user agent. Null
-- once the salt is erased. Only host addresses are stored (constraint below), so host(ip) loses
-- nothing.
CREATE FUNCTION "public"."audit_log_pii_canonical"(r "public"."audit_log") RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN r.pii_salt IS NULL THEN NULL ELSE
    'kobe.audit.pii.v1' || chr(10) || r.pii_salt || chr(10)
      || jsonb_build_array(r.id, host(r.ip), r.user_agent)::text END
$$;--> statement-breakpoint

-- One step of the upgrade seal over v1 rows: the previous seal, the row's stored hash and the
-- digest of its v2 view (every field but the raw IP and user agent).
CREATE FUNCTION "public"."audit_log_seal_step"(prev text, r "public"."audit_log") RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT "public"."audit_log_digest"('kobe.audit.seal.v1' || chr(10) || prev || chr(10) || r.hash
    || chr(10) || "public"."audit_log_digest"("public"."audit_log_canonical_v2"(r)))
$$;--> statement-breakpoint

-- How long rows keep their IP and user agent: install setting audit.pii_retention_hours, default
-- 12, clamped to 1-8760 whatever the stored text says.
CREATE FUNCTION "public"."audit_pii_retention_hours"() RETURNS integer
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((
    SELECT CASE WHEN s.value ~ '^[0-9]{1,6}$' THEN LEAST(GREATEST(s.value::integer, 1), 8760) END
    FROM "public"."install_settings" s WHERE s.key = 'audit.pii_retention_hours'), 12)
$$;--> statement-breakpoint

-- Whether a legal hold keeps an audit row's IP and user agent: a team-wide hold on the row's team,
-- or any active hold on its actor (a hold on a user in the row's team is one; the values are the
-- actor's personal data, so a user hold keeps their install-level rows such as sign-ins too).
CREATE FUNCTION "public"."audit_log_pii_held"(team uuid, actor uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."legal_holds" h
    WHERE h.status = 'active'
      AND ((h.user_id IS NULL AND h.team_id = team) OR h.user_id = actor))
$$;--> statement-breakpoint

-- The seal over the v1 rows as they are now, after verifying them strictly (seq from 1, prev_hash
-- links, every v1 hash, no salt or commitment); raises if they don't verify. Only valid before
-- any v1 row is erased (erasure needs the seal). NULLs when there are no v1 rows.
CREATE FUNCTION "public"."audit_log_v1_seal"(OUT seal text, OUT through_seq bigint, OUT n bigint)
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  r "public"."audit_log";
  prev text := repeat('0', 64);
BEGIN
  seal := repeat('0', 64);
  through_seq := 0;
  n := 0;
  FOR r IN SELECT * FROM "public"."audit_log" a WHERE a.hash_version IS NULL ORDER BY a.seq LOOP
    IF r.seq <> through_seq + 1 OR r.prev_hash <> prev OR r.pii_salt IS NOT NULL
       OR r.pii_commitment IS NOT NULL
       OR r.hash <> "public"."audit_log_digest"("public"."audit_log_canonical_v1"(r)) THEN
      RAISE EXCEPTION 'audit chain: row % before the upgrade does not verify; it cannot be sealed', r.seq
        USING ERRCODE = '42501';
    END IF;
    seal := "public"."audit_log_seal_step"(seal, r);
    prev := r.hash;
    through_seq := r.seq;
    n := n + 1;
  END LOOP;
  IF n = 0 THEN
    seal := NULL; through_seq := NULL;
  END IF;
END;
$$;--> statement-breakpoint

-- The seal event: `audit.chain.upgraded` by the system with a well-formed target. The append
-- trigger admits only one, and only with the recomputed seal of verified v1 rows, so for every
-- non-superuser writer such a row is the real seal.
CREATE FUNCTION "public"."audit_log_is_seal"(r "public"."audit_log") RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT r.action = 'audit.chain.upgraded' AND r.actor_kind = 'system' AND r.team_id IS NULL
    AND jsonb_typeof(r.target->'throughSeq') = 'number'
    AND coalesce(r.target->>'seal', '') ~ '^[0-9a-f]{64}$'
$$;--> statement-breakpoint

-- v1 rows may be erased only once the upgrade seal exists and is 24 hours old: until then they
-- can't be verified after erasure, and replicas of the previous release (which recompute v1 hashes)
-- may still be running (KOBE-17 review M3).
CREATE FUNCTION "public"."audit_log_v1_erasable"() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."audit_log" a
    WHERE a.action = 'audit.chain.upgraded' AND "public"."audit_log_is_seal"(a)
      AND a.at <= statement_timestamp() - interval '24 hours')
$$;--> statement-breakpoint

-- Appends are v2: the database assigns the salt and commitment along with seq and hashes.
CREATE OR REPLACE FUNCTION "public"."audit_log_append"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  active_team uuid := NULLIF(current_setting('kobe.team_id', true), '')::uuid;
  head record;
  seal_now record;
BEGIN
  IF NEW.seq <> 0 OR NEW.prev_hash <> '' OR NEW.hash <> '' OR NEW.hash_version IS NOT NULL
     OR NEW.pii_salt IS NOT NULL OR NEW.pii_commitment IS NOT NULL THEN
    RAISE EXCEPTION 'audit_log.seq, prev_hash, hash, hash_version, pii_salt and pii_commitment are assigned by the database; omit them'
      USING ERRCODE = '428C9';
  END IF;
  -- Inside withTeam(), an event may only belong to the active team (or to no team).
  IF active_team IS NOT NULL AND NEW.team_id IS NOT NULL AND NEW.team_id <> active_team THEN
    RAISE EXCEPTION 'audit event for team % written in the context of another team', NEW.team_id
      USING ERRCODE = '42501';
  END IF;
  IF NEW.action = 'audit.chain.upgraded' THEN
    -- The seal (KOBE-17 review N1): only from the system, only with the seal recomputed over the
    -- verified v1 rows. Checked before the chain lock (v1 rows can't change before a seal exists),
    -- so appends aren't blocked while the v1 rows are read.
    SELECT s.seal, s.through_seq, s.n INTO seal_now FROM "public"."audit_log_v1_seal"() s;
    IF NEW.actor_kind <> 'system' OR NEW.team_id IS NOT NULL OR seal_now.n = 0
       OR jsonb_typeof(NEW.target->'throughSeq') IS DISTINCT FROM 'number'
       OR jsonb_typeof(NEW.target->'rows') IS DISTINCT FROM 'number'
       OR NEW.target->>'throughSeq' IS DISTINCT FROM seal_now.through_seq::text
       OR NEW.target->>'rows' IS DISTINCT FROM seal_now.n::text
       OR NEW.target->>'seal' IS DISTINCT FROM seal_now.seal THEN
      RAISE EXCEPTION 'audit.chain.upgraded must carry the seal of the rows before the upgrade'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('kobe.audit_log', 0));
  IF NEW.action = 'audit.chain.upgraded' AND EXISTS (
       SELECT 1 FROM "public"."audit_log" a WHERE a.action = 'audit.chain.upgraded') THEN
    RAISE EXCEPTION 'the rows before the upgrade are already sealed' USING ERRCODE = '42501';
  END IF;
  SELECT a.seq, a.hash INTO head FROM "public"."audit_log" a ORDER BY a.seq DESC LIMIT 1;
  NEW.seq := coalesce(head.seq, 0) + 1;
  NEW.prev_hash := coalesce(head.hash, repeat('0', 64));
  NEW.at := clock_timestamp();
  NEW.hash_version := 2;
  IF NEW.ip IS NOT NULL OR NEW.user_agent IS NOT NULL THEN
    -- 244 random bits (pg_strong_random through gen_random_uuid; no extension needed).
    NEW.pii_salt := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    NEW.pii_commitment := "public"."audit_log_digest"("public"."audit_log_pii_canonical"(NEW));
  END IF;
  NEW.hash := "public"."audit_log_digest"("public"."audit_log_canonical"(NEW));
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- The only UPDATE allowed, for every role (owner included): ip, user_agent and pii_salt set to NULL
-- together, nothing else changed, on a row older than the retention period and not held; a v1 row
-- only once the upgrade seal is 24 hours old.
CREATE FUNCTION "public"."audit_log_erase_pii"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.seq, NEW.id, NEW.at, NEW.team_id, NEW.actor_kind, NEW.actor_id, NEW.action, NEW.target,
      NEW.prev_hash, NEW.hash, NEW.hash_version, NEW.pii_commitment)
     IS DISTINCT FROM
     (OLD.seq, OLD.id, OLD.at, OLD.team_id, OLD.actor_kind, OLD.actor_id, OLD.action, OLD.target,
      OLD.prev_hash, OLD.hash, OLD.hash_version, OLD.pii_commitment)
     OR NEW.ip IS NOT NULL OR NEW.user_agent IS NOT NULL OR NEW.pii_salt IS NOT NULL THEN
    RAISE EXCEPTION 'audit_log is append-only: the only change allowed is erasing ip and user_agent'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.ip IS NULL AND OLD.user_agent IS NULL AND OLD.pii_salt IS NULL THEN
    RETURN NEW; -- nothing left to erase
  END IF;
  IF OLD.at > statement_timestamp() - make_interval(hours => "public"."audit_pii_retention_hours"()) THEN
    RAISE EXCEPTION 'audit row % is inside the IP and user agent retention period', OLD.seq
      USING ERRCODE = '42501';
  END IF;
  IF OLD.hash_version IS NULL AND NOT "public"."audit_log_v1_erasable"() THEN
    RAISE EXCEPTION 'audit row % was chained before the upgrade: erasable 24 hours after audit.chain.upgraded', OLD.seq
      USING ERRCODE = '42501';
  END IF;
  PERFORM "public"."legal_hold_lock_shared"();
  IF "public"."audit_log_pii_held"(OLD.team_id, OLD.actor_id) THEN
    RAISE EXCEPTION 'audit row % is under legal hold', OLD.seq USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER "audit_log_refuse_update_delete" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "audit_log_erase_pii" BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "public"."audit_log_erase_pii"();--> statement-breakpoint
CREATE TRIGGER "audit_log_refuse_delete" BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "public"."audit_log_refuse_change"();--> statement-breakpoint

-- NOT VALID: no scan under the migration's lock. Every existing (v1) row satisfies them (the new
-- columns are NULL); every new or changed row, restores included, is checked.
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_hash_version"
  CHECK ("hash_version" IS NULL OR "hash_version" = 2) NOT VALID;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_pii_salt_format"
  CHECK ("pii_salt" IS NULL OR "pii_salt" ~ '^[0-9a-f]{64}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_pii_commitment_format"
  CHECK ("pii_commitment" IS NULL OR "pii_commitment" ~ '^[0-9a-f]{64}$') NOT VALID;--> statement-breakpoint
-- A v2 row's IP or user agent is always salted and committed (erasure removes values and salt).
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_pii_salted"
  CHECK ("hash_version" IS NULL OR ("ip" IS NULL AND "user_agent" IS NULL) OR "pii_salt" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_pii_committed"
  CHECK ("pii_salt" IS NULL OR "pii_commitment" IS NOT NULL) NOT VALID;--> statement-breakpoint
-- v1 rows carry no salt or commitment (their hash covers the raw values).
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_v1_uncommitted"
  CHECK ("hash_version" IS NOT NULL OR ("pii_salt" IS NULL AND "pii_commitment" IS NULL)) NOT VALID;--> statement-breakpoint
-- Host addresses only (the commitment and the v1 hash use host(ip), which drops a netmask).
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_ip_host"
  CHECK ("ip" IS NULL OR masklen("ip") = CASE WHEN family("ip") = 4 THEN 32 ELSE 128 END) NOT VALID;--> statement-breakpoint

-- The whole-chain check in SQL (the restore runs it inside its transaction; verifyAuditChain() is
-- its Node twin, hashing independently of these functions). Returns the first problem, or NULLs
-- and the head. Rules per row:
--   v1 (hash_version NULL): only before any v2 row; no salt or commitment; its v1 hash matches, or
--     its IP and user agent are gone (erased), which a valid upgrade seal must then vouch for.
--   v2: its hash matches; with a salt, the commitment matches; without one, no IP or user agent.
--   audit.chain.upgraded: exactly one, by the system, after v1 rows, throughSeq the last v1 row and
--     seal the running seal; a second one is extra_seal.
CREATE FUNCTION "public"."audit_log_chain_problem"(
  OUT problem_seq bigint, OUT problem text, OUT head_seq bigint, OUT head_hash text)
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  r record;
  want bigint := 1;
  prev text := repeat('0', 64);
  seal text := repeat('0', 64);
  last_v1 bigint := 0;
  saw_v2 boolean := false;
  sealed boolean := false;
  pending bigint := NULL;
BEGIN
  head_seq := 0;
  FOR r IN SELECT a.seq, a.prev_hash, a.hash, a.hash_version, a.action, a.actor_kind, a.target,
      a.pii_salt, a.pii_commitment, (a.ip IS NULL AND a.user_agent IS NULL) AS no_pii,
      "public"."audit_log_digest"("public"."audit_log_canonical"(a)) AS computed,
      a AS whole,
      "public"."audit_log_digest"("public"."audit_log_pii_canonical"(a)) AS pii
    FROM "public"."audit_log" a ORDER BY a.seq LOOP
    problem_seq := r.seq;
    IF r.seq <> want THEN problem := 'gap'; RETURN; END IF;
    IF r.prev_hash <> prev THEN problem := 'prev_hash_mismatch'; RETURN; END IF;
    IF r.hash_version IS NULL THEN
      IF saw_v2 THEN problem := 'hash_mismatch'; RETURN; END IF;
      IF r.pii_salt IS NOT NULL OR r.pii_commitment IS NOT NULL THEN
        problem := 'pii_mismatch'; RETURN;
      END IF;
      IF r.hash <> r.computed THEN
        IF NOT r.no_pii THEN problem := 'hash_mismatch'; RETURN; END IF;
        pending := coalesce(pending, r.seq);
      END IF;
      seal := "public"."audit_log_seal_step"(seal, r.whole);
      last_v1 := r.seq;
    ELSE
      IF r.hash_version <> 2 OR r.hash <> r.computed THEN problem := 'hash_mismatch'; RETURN; END IF;
      IF r.pii_salt IS NOT NULL THEN
        IF r.pii_commitment IS DISTINCT FROM r.pii THEN problem := 'pii_mismatch'; RETURN; END IF;
      ELSIF NOT r.no_pii THEN
        problem := 'pii_mismatch'; RETURN;
      END IF;
      saw_v2 := true;
      IF r.action = 'audit.chain.upgraded' THEN
        -- The append trigger admits one, carrying the real seal: a second is "extra_seal", a
        -- first that doesn't match is "seal_mismatch" (both only possible past the triggers).
        IF sealed THEN problem := 'extra_seal'; RETURN; END IF;
        IF last_v1 = 0 OR NOT "public"."audit_log_is_seal"(r.whole)
           OR r.target->>'throughSeq' IS DISTINCT FROM last_v1::text
           OR r.target->>'seal' IS DISTINCT FROM seal THEN
          problem := 'seal_mismatch'; RETURN;
        END IF;
        sealed := true;
      END IF;
    END IF;
    prev := r.hash;
    want := want + 1;
    head_seq := r.seq;
    head_hash := r.hash;
  END LOOP;
  IF pending IS NOT NULL AND NOT sealed THEN
    problem_seq := pending; problem := 'hash_mismatch'; RETURN;
  END IF;
  problem_seq := NULL;
  problem := NULL;
END;
$$;
