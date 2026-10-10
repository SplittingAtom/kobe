-- Atomic reserve and settle for shared budget reservations (KOBE-120). Invoker's rights (the repo
-- has no SECURITY DEFINER functions): the app role's grants and the team policy apply inside.
-- Each is one statement, so one round trip. They set the team context themselves (the same
-- transaction-local setting withTeam() sets) and refuse a different team already in force.
--
-- kobe_reserve_budget: p_lines is a JSON array of the member's budget lines as the caller read
-- them, [{"scope":"install|team|user","unit":"usd|tokens","limit":"12.5","spent":"3"}, ...]. The
-- call is admitted only if, on every line, spend plus the others' live reservations (each member
-- counted up to p_member_share of what is left on a shared line) stays below the limit, and the
-- member's own share is not exceeded. Returns 'ok', 'full:<line index>' or 'own_share:<index>'.
-- Atomic: transaction-scoped advisory locks (the team's, then the install's, always in that order)
-- serialise reservers; plpgsql takes a new snapshot per statement, so the sums below see every
-- reservation committed by a reserver that held the lock before. Expired rows never count.
CREATE FUNCTION "kobe_reserve_budget"(
  p_team uuid, p_user uuid, p_call text, p_usd numeric, p_tokens bigint,
  p_ttl_ms integer, p_member_share numeric, p_lines jsonb
) RETURNS text LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
DECLARE
  cur text := NULLIF(current_setting('kobe.team_id', true), '');
  expiry timestamptz := clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0);
  has_install boolean;
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
  has_install := EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE l->>'scope' = 'install');
  PERFORM pg_advisory_xact_lock(hashtextextended('kobe.budget:team:' || p_team::text, 0));
  IF has_install THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('kobe.budget:install', 0));
  END IF;
  -- The sweep: rows long expired (a minute past their expiry; they never counted) are removed here,
  -- under the locks, so no separate sweeper is needed. The install-wide rows of every team go too.
  DELETE FROM "budget_reservations"
    WHERE team_id = p_team AND expires_at <= clock_timestamp() - interval '1 minute';
  IF has_install THEN
    DELETE FROM "install_budget_reservations"
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
    self_key := CASE WHEN line->>'scope' = 'install' THEN p_team::text || ':' || p_user::text
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
            FROM "install_budget_reservations"
            WHERE line->>'scope' = 'install'
              AND expires_at > clock_timestamp() AND call_id <> p_call
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
  IF has_install THEN
    INSERT INTO "install_budget_reservations" ("call_id", "member_key", "usd", "tokens", "expires_at")
      VALUES (p_call, p_team::text || ':' || p_user::text, p_usd, p_tokens, expiry)
      ON CONFLICT ("call_id") DO UPDATE
        SET "usd" = EXCLUDED."usd", "tokens" = EXCLUDED."tokens", "expires_at" = EXCLUDED."expires_at";
  END IF;
  RETURN 'ok';
END $$;--> statement-breakpoint
-- kobe_settle_budget: ends these calls' reservations. p_keep_ms NULL deletes them; otherwise it
-- shortens their expiry to at most that long from now (the call ended but its ledger row has not
-- landed: the reservation stays a little longer, never longer than it already would).
CREATE FUNCTION "kobe_settle_budget"(p_team uuid, p_calls text[], p_keep_ms integer)
RETURNS integer LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
DECLARE
  cur text := NULLIF(current_setting('kobe.team_id', true), '');
  keep timestamptz := clock_timestamp() + make_interval(secs => COALESCE(p_keep_ms, 0) / 1000.0);
  n integer;
BEGIN
  IF cur IS NOT NULL AND cur <> p_team::text THEN
    RAISE EXCEPTION 'kobe_settle_budget: another team is in force' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('kobe.team_id', p_team::text, true);
  IF p_keep_ms IS NULL THEN
    DELETE FROM "install_budget_reservations" WHERE call_id = ANY (p_calls);
    DELETE FROM "budget_reservations" WHERE team_id = p_team AND call_id = ANY (p_calls);
  ELSE
    UPDATE "install_budget_reservations" SET expires_at = least(expires_at, keep)
      WHERE call_id = ANY (p_calls);
    UPDATE "budget_reservations" SET expires_at = least(expires_at, keep)
      WHERE team_id = p_team AND call_id = ANY (p_calls);
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
