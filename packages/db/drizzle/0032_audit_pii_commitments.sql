-- Audit chain v2 (KOBE-17; user decision 2026-10-03): the client IP and user agent of each audit
-- row are erased after a configurable period, and the chain must still verify. Design and review:
-- docs/audit-log.md ("IP and user agent") and docs/ledger/KOBE-17.md.
--
--   * v2 rows hash a salted commitment to (id, IP, user agent) instead of the raw values, so the
--     values and the salt can be nulled later without touching the hash. While present, the values
--     are checked against the commitment; once the salt is gone the commitment reveals nothing.
--   * v1 rows (chained before this migration) keep their stored hashes, so every head already
--     anchored off the box stays valid. They get a salt and commitment too, and a running seal over
--     all of them goes into an `audit.chain.upgraded` event, the first v2 row: an erased v1 row
--     (whose v1 hash can no longer be recomputed) is verified through the seal.
--   * The app role may erase (column grants on ip, user_agent, pii_salt); the update trigger allows
--     nothing else, only for rows older than the configured period and not under a legal hold.
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
-- row in the upgrade seal. Changing it invalidates every v2 hash: version it (kobe.audit.v3).
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
  SELECT CASE WHEN r.hash_version = 1 THEN "public"."audit_log_canonical_v1"(r)
              ELSE "public"."audit_log_canonical_v2"(r) END
$$;--> statement-breakpoint

-- Input of pii_commitment: salt, row id (binds the values to this row), IP and user agent. Null
-- once the salt is erased.
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

-- Whether a legal hold keeps an audit row's IP and user agent: the row's team is held (team-wide
-- or for its actor), or its actor is the subject of any active user hold (the values are the
-- actor's personal data, so a user hold keeps their install-level rows such as sign-ins too).
-- (A hold on a user in the row's team is a hold on its actor, so: a team-wide hold on the row's
-- team, or any active hold on its actor.)
CREATE FUNCTION "public"."audit_log_pii_held"(team uuid, actor uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."legal_holds" h
    WHERE h.status = 'active'
      AND ((h.user_id IS NULL AND h.team_id = team) OR h.user_id = actor))
$$;--> statement-breakpoint

-- 0. No appends (old replicas keep running during the upgrade) until this migration commits.
LOCK TABLE "audit_log" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

-- 1. The chain as it stands must verify (v1); a break is an integrity incident to investigate
--    before upgrading, and sealing it would hide it.
DO $kobe$
DECLARE
  r record;
  want bigint := 1;
  prev text := repeat('0', 64);
BEGIN
  FOR r IN SELECT a.seq, a.prev_hash, a.hash,
      "public"."audit_log_digest"("public"."audit_log_canonical_v1"(a)) AS computed
    FROM "public"."audit_log" a ORDER BY a.seq LOOP
    IF r.seq <> want OR r.prev_hash <> prev OR r.hash <> r.computed THEN
      RAISE EXCEPTION 'audit chain upgrade: the existing chain is broken at seq %; investigate (GET /v1/install/audit/integrity) before upgrading', r.seq;
    END IF;
    prev := r.hash;
    want := want + 1;
  END LOOP;
END
$kobe$;--> statement-breakpoint

-- 2. Existing rows are v1; those with an IP or user agent get a salt and commitment. Their stored
--    hashes don't change. The refusal trigger is replaced below.
ALTER TABLE "audit_log" DISABLE TRIGGER "audit_log_refuse_update_delete";--> statement-breakpoint
-- One pass over the table (one row version each): version, salt and commitment together.
UPDATE "audit_log" a
  SET "hash_version" = 1,
      "pii_salt" = s.salt,
      "pii_commitment" = CASE WHEN s.salt IS NULL THEN NULL ELSE "public"."audit_log_digest"(
        'kobe.audit.pii.v1' || chr(10) || s.salt || chr(10)
          || jsonb_build_array(a.id, host(a.ip), a.user_agent)::text) END
  FROM (SELECT b.seq, CASE WHEN b.ip IS NOT NULL OR b.user_agent IS NOT NULL THEN
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
        END AS salt
        FROM "audit_log" b) s
  WHERE s.seq = a.seq;--> statement-breakpoint
DROP TRIGGER "audit_log_refuse_update_delete" ON "audit_log";--> statement-breakpoint

ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_hash_version" CHECK ("hash_version" IN (1, 2));--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_pii_salt_format"
  CHECK ("pii_salt" IS NULL OR "pii_salt" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_pii_commitment_format"
  CHECK ("pii_commitment" IS NULL OR "pii_commitment" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
-- An IP or user agent is always salted and committed (erasure removes values and salt together).
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_pii_salted"
  CHECK (("ip" IS NULL AND "user_agent" IS NULL) OR "pii_salt" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_pii_committed"
  CHECK ("pii_salt" IS NULL OR "pii_commitment" IS NOT NULL);--> statement-breakpoint

-- 3. Appends are v2: the database assigns the salt and commitment along with seq and hashes.
CREATE OR REPLACE FUNCTION "public"."audit_log_append"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  active_team uuid := NULLIF(current_setting('kobe.team_id', true), '')::uuid;
  head record;
BEGIN
  IF NEW.seq <> 0 OR NEW.prev_hash <> '' OR NEW.hash <> '' OR NEW.hash_version <> 2
     OR NEW.pii_salt IS NOT NULL OR NEW.pii_commitment IS NOT NULL THEN
    RAISE EXCEPTION 'audit_log.seq, prev_hash, hash, hash_version, pii_salt and pii_commitment are assigned by the database; omit them'
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

-- 4. The only UPDATE allowed, for every role (owner included): ip, user_agent and pii_salt set to
--    NULL together, nothing else changed, on a row older than the retention period and not held.
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
  IF OLD.pii_salt IS NULL THEN
    RETURN NEW; -- nothing left to erase
  END IF;
  IF OLD.at > statement_timestamp() - make_interval(hours => "public"."audit_pii_retention_hours"()) THEN
    RAISE EXCEPTION 'audit row % is inside the IP and user agent retention period', OLD.seq
      USING ERRCODE = '42501';
  END IF;
  PERFORM "public"."legal_hold_lock_shared"();
  IF "public"."audit_log_pii_held"(OLD.team_id, OLD.actor_id) THEN
    RAISE EXCEPTION 'audit row % is under legal hold', OLD.seq USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_log_erase_pii" BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "public"."audit_log_erase_pii"();--> statement-breakpoint
CREATE TRIGGER "audit_log_refuse_delete" BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "public"."audit_log_refuse_change"();--> statement-breakpoint

-- 5. Seal the v1 rows into the chain (only when there are any: a fresh install stays empty).
DO $kobe$
DECLARE
  r "public"."audit_log";
  seal text := repeat('0', 64);
  last_seq bigint := 0;
  n bigint := 0;
BEGIN
  FOR r IN SELECT * FROM "public"."audit_log" a WHERE a.hash_version = 1 ORDER BY a.seq LOOP
    seal := "public"."audit_log_seal_step"(seal, r);
    last_seq := r.seq;
    n := n + 1;
  END LOOP;
  IF n > 0 THEN
    INSERT INTO "public"."audit_log" (actor_kind, action, target)
      VALUES ('system', 'audit.chain.upgraded',
              jsonb_build_object('throughSeq', last_seq, 'rows', n, 'seal', seal));
  END IF;
END
$kobe$;--> statement-breakpoint

-- 6. The whole-chain check in SQL (the restore runs it inside its transaction; verifyAuditChain()
--    is its Node twin, hashing independently of these functions). Returns the first problem, or
--    NULLs and the head.
CREATE FUNCTION "public"."audit_log_chain_problem"(
  OUT problem_seq bigint, OUT problem text, OUT head_seq bigint, OUT head_hash text)
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  r record;
  want bigint := 1;
  prev text := repeat('0', 64);
  seal text := repeat('0', 64);
  last_v1 bigint := 0;
  sealed boolean := false;
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
    IF r.hash_version = 1 THEN
      -- v1 rows only before the upgrade event; an erased one is checked through the seal.
      IF sealed THEN problem := 'hash_mismatch'; RETURN; END IF;
      IF NOT (r.pii_salt IS NULL AND r.pii_commitment IS NOT NULL) AND r.hash <> r.computed THEN
        problem := 'hash_mismatch'; RETURN;
      END IF;
      seal := "public"."audit_log_seal_step"(seal, r.whole);
      last_v1 := r.seq;
    ELSE
      IF r.hash <> r.computed THEN problem := 'hash_mismatch'; RETURN; END IF;
      IF last_v1 > 0 AND NOT sealed AND (r.action <> 'audit.chain.upgraded'
          OR r.actor_kind <> 'system'
          OR r.target->>'seal' IS DISTINCT FROM seal
          OR jsonb_typeof(r.target->'throughSeq') IS DISTINCT FROM 'number'
          OR r.target->>'throughSeq' IS DISTINCT FROM last_v1::text) THEN
        problem := 'seal_mismatch'; RETURN;
      END IF;
      sealed := true;
    END IF;
    IF r.pii_salt IS NOT NULL THEN
      IF r.pii_commitment IS DISTINCT FROM r.pii THEN problem := 'pii_mismatch'; RETURN; END IF;
    ELSIF NOT r.no_pii THEN
      problem := 'pii_mismatch'; RETURN;
    END IF;
    prev := r.hash;
    want := want + 1;
    head_seq := r.seq;
    head_hash := r.hash;
  END LOOP;
  IF last_v1 > 0 AND NOT sealed THEN
    problem_seq := last_v1; problem := 'seal_mismatch'; RETURN;
  END IF;
  problem_seq := NULL;
  problem := NULL;
END;
$$;
