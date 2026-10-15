-- KOBE-286: kobe_reserve_budget reads each line's spend itself, from the daily counters the
-- run_usage trigger keeps, in the same statement (one snapshot) as the live reservations it
-- counts. A call's ledger row and its counters commit in one transaction while its reservation
-- still exists (the gateway ends it only after the row landed), so whichever side of that commit
-- the snapshot falls, the call counts exactly once: in spend, or as a reservation. The caller's
-- cached spend no longer matters, and a settled reservation can end at once (no settle hold, no
-- double count of a written call).
--
-- Unchanged from KOBE-120: invoker's rights (never SECURITY DEFINER), search_path pinned, the team
-- set with transaction-local set_config and a different team already in force refused, the team
-- then the site advisory lock (always in that order), expired rows never count, the sweep.
--
-- p_lines entries now carry "period" ("month" | "day", UTC periods on the database clock); the
-- line's "spent" is ignored then. An entry without "period" (a gateway of the release before,
-- during a rollout) is judged on its "spent" as before. Site spend comes from
-- site_model_spend_daily, team spend from model_spend_daily (the team's rows: the team policy
-- applies), member spend from the member's rows there.
CREATE OR REPLACE FUNCTION public.kobe_reserve_budget(p_team uuid, p_user uuid, p_call text, p_usd numeric, p_tokens bigint, p_ttl_ms integer, p_member_share numeric, p_lines jsonb, p_salt text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  cur text := NULLIF(current_setting('kobe.team_id', true), '');
  expiry timestamptz := clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0);
  v_today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  has_site boolean;
  v_team_key text := encode(sha256(convert_to(p_salt || ':team:' || p_team::text, 'utf8')), 'hex');
  v_member_key text := encode(sha256(convert_to(p_salt || ':member:' || p_team::text || ':' || p_user::text, 'utf8')), 'hex');
  n integer := jsonb_array_length(p_lines);
  i integer;
  line jsonb;
  unit_usd boolean;
  is_site boolean;
  v_period text;
  v_from date;
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
    is_site := line->>'scope' IN ('site', 'install');
    v_period := line->>'period';
    IF v_period IS NOT NULL AND v_period NOT IN ('month', 'day') THEN
      RAISE EXCEPTION 'kobe_reserve_budget: unknown period %', v_period USING ERRCODE = '22023';
    END IF;
    v_from := CASE v_period WHEN 'month' THEN date_trunc('month', v_today)::date ELSE v_today END;
    lim := (line->>'limit')::numeric;
    cost := CASE WHEN unit_usd THEN p_usd ELSE p_tokens END;
    self_key := CASE WHEN is_site THEN v_member_key ELSE p_user::text END;
    -- One statement, one snapshot: the spend and the reservations it is judged with.
    SELECT sp.amt,
           -- least() skips NULLs: without a reservation (the LEFT JOIN's NULL row) it adds nothing.
           COALESCE(sum(least(m.amt, sh.share)) FILTER (WHERE m.member IS NOT NULL), 0),
           COALESCE(sum(m.amt) FILTER (WHERE m.member = self_key), 0),
           COALESCE(bool_or(m.member <> self_key), false)
      INTO spent, total, own, others
      FROM (
        SELECT CASE
          WHEN v_period IS NULL THEN (line->>'spent')::numeric
          WHEN is_site THEN (
            SELECT COALESCE(sum(CASE WHEN unit_usd THEN s.cost_usd ELSE s.tokens::numeric END), 0)
              FROM "site_model_spend_daily" s WHERE s.day >= v_from)
          ELSE (
            SELECT COALESCE(sum(CASE WHEN unit_usd THEN s.cost_usd ELSE s.tokens::numeric END), 0)
              FROM "model_spend_daily" s
              WHERE s.team_id = p_team AND s.day >= v_from
                AND (line->>'scope' = 'team' OR s.user_id = p_user))
        END AS amt
      ) sp
      CROSS JOIN LATERAL (
        SELECT CASE WHEN line->>'scope' = 'user' THEN 'Infinity'::numeric
                    ELSE greatest(0, lim - sp.amt) * p_member_share END AS share
      ) sh
      LEFT JOIN (
        SELECT r.member, sum(r.amt) AS amt FROM (
          SELECT user_id::text AS member, CASE WHEN unit_usd THEN usd ELSE tokens::numeric END AS amt
            FROM "budget_reservations"
            WHERE line->>'scope' IN ('team', 'user') AND team_id = p_team
              AND (line->>'scope' = 'team' OR user_id = p_user)
              AND expires_at > clock_timestamp() AND call_id <> p_call
          UNION ALL
          SELECT member_key, CASE WHEN unit_usd THEN usd ELSE tokens::numeric END
            FROM "site_budget_reservations"
            WHERE is_site
              AND expires_at > clock_timestamp() AND NOT (team_key = v_team_key AND call_id = p_call)
        ) r GROUP BY r.member
      ) m ON true
      GROUP BY sp.amt;
    share := CASE WHEN line->>'scope' = 'user' THEN 'Infinity'::numeric
                  ELSE greatest(0, lim - spent) * p_member_share END;
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
