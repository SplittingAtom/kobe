-- KOBE-443: kobe_reserve_budget counts every live reservation in full.
--
-- Before, each member's live reservations on a shared line counted only up to the member share of
-- what is left (`sum(least(m.amt, sh.share))`, since KOBE-120). Since KOBE-286 (0097) the spend is
-- read fresh in the same snapshot, so that share shrinks while calls are in flight: holds a member
-- took while the share was larger were then undercounted, and a call was admitted although spend
-- plus the live holds had already reached the limit (more than one call over a hard budget; PR
-- #317's merge queue: limit 683, 12 calls of 65 admitted). A member's holds are still capped when
-- taken (`own_share`), so counting them in full refuses only what the old count wrongly admitted;
-- a lone call larger than the share (admitted because nobody else held anything) now also counts
-- in full, so others wait for it.
--
-- Only that sum changes (and the unused share join goes). Everything else is 0148's: same
-- signature (owner, grants and callers untouched), invoker's rights (never SECURITY DEFINER),
-- pinned search_path, the team set transaction-locally and a different team in force refused,
-- the team then the site lock, one snapshot per line, expired rows never count, the sweep, the
-- eval line. Rolling upgrade: a previous release's gateway calls the same function.
CREATE OR REPLACE FUNCTION public.kobe_reserve_budget(p_team uuid, p_user uuid, p_call text, p_usd numeric, p_tokens bigint, p_ttl_ms integer, p_member_share numeric, p_lines jsonb, p_salt text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  cur text := NULLIF(current_setting('kobe.team_id', true), '');
  expiry timestamptz := clock_timestamp() + make_interval(secs => p_ttl_ms / 1000.0);
  v_today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  has_site boolean := false;
  has_eval boolean := false;
  v_team_key text := encode(sha256(convert_to(p_salt || ':team:' || p_team::text, 'utf8')), 'hex');
  v_member_key text := encode(sha256(convert_to(p_salt || ':member:' || p_team::text || ':' || p_user::text, 'utf8')), 'hex');
  n integer := jsonb_array_length(p_lines);
  i integer;
  pass integer;
  line jsonb;
  unit_usd boolean;
  v_scope text;
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
  -- A malformed line is refused before any lock: never judged as "no limit".
  FOR i IN 0 .. n - 1 LOOP
    line := p_lines -> i;
    IF jsonb_typeof(line) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'kobe_reserve_budget: line % is not an object', i USING ERRCODE = '22023';
    END IF;
    IF (line->>'scope') IS NULL OR (line->>'scope') NOT IN ('site', 'install', 'team', 'user', 'eval') THEN
      RAISE EXCEPTION 'kobe_reserve_budget: unknown scope %', line->>'scope' USING ERRCODE = '22023';
    END IF;
    IF (line->>'unit') IS NULL OR (line->>'unit') NOT IN ('usd', 'tokens') THEN
      RAISE EXCEPTION 'kobe_reserve_budget: unknown unit %', line->>'unit' USING ERRCODE = '22023';
    END IF;
    IF (line->>'period') IS NOT NULL AND (line->>'period') NOT IN ('month', 'day') THEN
      RAISE EXCEPTION 'kobe_reserve_budget: unknown period %', line->>'period' USING ERRCODE = '22023';
    END IF;
    IF (line->>'limit') IS NULL OR (line->>'limit')::numeric = 'NaN'::numeric THEN
      RAISE EXCEPTION 'kobe_reserve_budget: line % has no limit', i USING ERRCODE = '22023';
    END IF;
    IF (line->>'period') IS NULL
       AND ((line->>'spent') IS NULL OR (line->>'spent')::numeric = 'NaN'::numeric) THEN
      RAISE EXCEPTION 'kobe_reserve_budget: line % has no period and no spend', i USING ERRCODE = '22023';
    END IF;
    has_site := has_site OR (line->>'scope') IN ('site', 'install');
    has_eval := has_eval OR (line->>'scope') = 'eval';
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended('kobe.budget:team:' || p_team::text, 0));
  -- The sweep: rows long expired (a minute past their expiry; they never counted) are removed here,
  -- under the locks, so no separate sweeper is needed. The site-wide rows of every team go too.
  DELETE FROM "budget_reservations"
    WHERE team_id = p_team AND expires_at <= clock_timestamp() - interval '1 minute';
  -- Pass 1: team and member lines, under the team lock. Pass 2: site lines, under the site lock.
  FOR pass IN 1 .. 2 LOOP
    IF pass = 2 THEN
      EXIT WHEN NOT has_site;
      PERFORM pg_advisory_xact_lock(hashtextextended('kobe.budget:site', 0));
      DELETE FROM "site_budget_reservations"
        WHERE expires_at <= clock_timestamp() - interval '1 minute';
    END IF;
    FOR i IN 0 .. n - 1 LOOP
      line := p_lines -> i;
      v_scope := CASE WHEN line->>'scope' IN ('site', 'install') THEN 'site' ELSE line->>'scope' END;
      CONTINUE WHEN (v_scope = 'site') <> (pass = 2);
      unit_usd := line->>'unit' = 'usd';
      v_period := line->>'period';
      v_from := CASE v_period WHEN 'month' THEN date_trunc('month', v_today::timestamp)::date
                              ELSE v_today END;
      lim := (line->>'limit')::numeric;
      cost := CASE WHEN unit_usd THEN p_usd ELSE p_tokens END;
      self_key := CASE WHEN v_scope = 'site' THEN v_member_key ELSE p_user::text END;
      -- One statement, one snapshot: the spend and the reservations it is judged with. Each
      -- branch has plain predicates (the scope test is a one-time filter in any plan).
      SELECT sp.amt,
             -- Every live hold in full (KOBE-443): never capped at today's share.
             COALESCE(sum(m.amt) FILTER (WHERE m.member IS NOT NULL), 0),
             COALESCE(sum(m.amt) FILTER (WHERE m.member = self_key), 0),
             COALESCE(bool_or(m.member <> self_key), false)
        INTO spent, total, own, others
        FROM (
          SELECT CASE
            WHEN v_period IS NULL THEN (line->>'spent')::numeric
            WHEN v_scope = 'site' THEN (
              SELECT COALESCE(sum(CASE WHEN unit_usd THEN s.cost_usd ELSE s.tokens::numeric END), 0)
                FROM "site_model_spend_daily" s WHERE s.day >= v_from)
            WHEN v_scope = 'team' THEN (
              SELECT COALESCE(sum(CASE WHEN unit_usd THEN s.cost_usd ELSE s.tokens::numeric END), 0)
                FROM "model_spend_daily" s WHERE s.team_id = p_team AND s.day >= v_from)
            WHEN v_scope = 'eval' THEN (
              SELECT COALESCE(sum(CASE WHEN unit_usd THEN s.eval_cost_usd ELSE s.eval_tokens::numeric END), 0)
                FROM "model_spend_daily" s WHERE s.team_id = p_team AND s.day >= v_from)
            ELSE (
              SELECT COALESCE(sum(CASE WHEN unit_usd THEN s.cost_usd ELSE s.tokens::numeric END), 0)
                FROM "model_spend_daily" s
                WHERE s.team_id = p_team AND s.user_id = p_user AND s.day >= v_from)
          END AS amt
        ) sp
        LEFT JOIN (
          SELECT r.member, sum(r.amt) AS amt FROM (
            SELECT user_id::text AS member, CASE WHEN unit_usd THEN usd ELSE tokens::numeric END AS amt
              FROM "budget_reservations"
              WHERE v_scope = 'team' AND team_id = p_team
                AND expires_at > clock_timestamp() AND call_id <> p_call
            UNION ALL
            SELECT user_id::text, CASE WHEN unit_usd THEN usd ELSE tokens::numeric END
              FROM "budget_reservations"
              WHERE v_scope = 'user' AND team_id = p_team AND user_id = p_user
                AND expires_at > clock_timestamp() AND call_id <> p_call
            UNION ALL
            SELECT user_id::text, CASE WHEN unit_usd THEN usd ELSE tokens::numeric END
              FROM "budget_reservations"
              WHERE v_scope = 'eval' AND team_id = p_team AND eval
                AND expires_at > clock_timestamp() AND call_id <> p_call
            UNION ALL
            SELECT member_key, CASE WHEN unit_usd THEN usd ELSE tokens::numeric END
              FROM "site_budget_reservations"
              WHERE v_scope = 'site'
                AND expires_at > clock_timestamp() AND NOT (team_key = v_team_key AND call_id = p_call)
          ) r GROUP BY r.member
        ) m ON true
        GROUP BY sp.amt;
      share := CASE WHEN v_scope = 'user' THEN 'Infinity'::numeric
                    ELSE greatest(0, lim - spent) * p_member_share END;
      IF spent + total >= lim THEN
        RETURN 'full:' || i;
      END IF;
      IF (own > 0 OR others) AND own + cost > share THEN
        RETURN 'own_share:' || i;
      END IF;
    END LOOP;
  END LOOP;
  INSERT INTO "budget_reservations" ("team_id", "call_id", "user_id", "usd", "tokens", "eval", "expires_at")
    VALUES (p_team, p_call, p_user, p_usd, p_tokens, has_eval, expiry)
    ON CONFLICT ("team_id", "call_id") DO UPDATE
      SET "usd" = EXCLUDED."usd", "tokens" = EXCLUDED."tokens", "eval" = EXCLUDED."eval",
          "expires_at" = EXCLUDED."expires_at";
  IF has_site THEN
    INSERT INTO "site_budget_reservations" ("team_key", "call_id", "member_key", "usd", "tokens", "expires_at")
      VALUES (v_team_key, p_call, v_member_key, p_usd, p_tokens, expiry)
      ON CONFLICT ("team_key", "call_id") DO UPDATE
        SET "usd" = EXCLUDED."usd", "tokens" = EXCLUDED."tokens", "expires_at" = EXCLUDED."expires_at";
  END IF;
  RETURN 'ok';
END $function$;
