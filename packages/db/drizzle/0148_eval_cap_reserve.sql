-- KOBE-327 (SK18): skill evals' spend and the team eval cap, through the budget reservation path
-- (KOBE-120/286), so the cap holds atomically across gateway replicas: no separate check-then-act.
--
-- 1. kobe_count_model_spend (the run_usage statement trigger) also counts the rows of kinds
--    `eval` and `eval_judge` into model_spend_daily.eval_cost_usd / eval_tokens (0149). No
--    backfill: those kinds are new in this release (0148), so no earlier row has them.
-- 2. kobe_reserve_budget takes a line of scope `eval` (the team eval cap, sent by the gateway on
--    every eval sandbox and eval judge call while the team sets a cap): judged under the team lock
--    like a team line, on the team's eval spend this period and the live reservations of other
--    eval calls (`budget_reservations.eval`), with the same member share. A call that carries an
--    `eval` line is reserved with `eval = true`. Everything else is 0097's, unchanged: invoker's
--    rights, pinned search_path, the team set transaction-locally and a different team in force
--    refused, the team then the site lock, expired rows never count, the sweep.
--
-- Rolling upgrade / rollback: the signature is unchanged. A previous release's gateway sends no
-- `eval` line, so its reservations stay `eval = false` and its calls are judged exactly as before;
-- its spend trigger body is replaced here, and the new columns default to 0.
CREATE OR REPLACE FUNCTION public.kobe_count_model_spend()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  INSERT INTO "model_spend_daily" ("team_id", "day", "user_id", "cost_usd", "tokens", "calls",
                                   "eval_cost_usd", "eval_tokens")
  SELECT "team_id", ("at" AT TIME ZONE 'UTC')::date, "user_id", COALESCE(sum("cost_usd"), 0),
         sum("input_tokens"::bigint + "output_tokens" + "cache_read_tokens" + "cache_write_tokens"), count(*),
         COALESCE(sum("cost_usd") FILTER (WHERE "kind" IN ('eval', 'eval_judge')), 0),
         COALESCE(sum("input_tokens"::bigint + "output_tokens" + "cache_read_tokens" + "cache_write_tokens")
                    FILTER (WHERE "kind" IN ('eval', 'eval_judge')), 0)
    FROM "new_rows" GROUP BY 1, 2, 3
  ON CONFLICT ("team_id", "day", "user_id") DO UPDATE
    SET "cost_usd" = "model_spend_daily"."cost_usd" + EXCLUDED."cost_usd",
        "tokens" = "model_spend_daily"."tokens" + EXCLUDED."tokens",
        "calls" = "model_spend_daily"."calls" + EXCLUDED."calls",
        "eval_cost_usd" = "model_spend_daily"."eval_cost_usd" + EXCLUDED."eval_cost_usd",
        "eval_tokens" = "model_spend_daily"."eval_tokens" + EXCLUDED."eval_tokens";
  INSERT INTO "site_model_spend_daily" ("day", "cost_usd", "tokens")
  SELECT ("at" AT TIME ZONE 'UTC')::date, COALESCE(sum("cost_usd"), 0), sum("input_tokens"::bigint + "output_tokens" + "cache_read_tokens" + "cache_write_tokens")
    FROM "new_rows" GROUP BY 1
  ON CONFLICT ("day") DO UPDATE
    SET "cost_usd" = "site_model_spend_daily"."cost_usd" + EXCLUDED."cost_usd",
        "tokens" = "site_model_spend_daily"."tokens" + EXCLUDED."tokens";
  RETURN NULL;
END $function$;
--> statement-breakpoint
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
             -- least() skips NULLs: without a reservation (the LEFT JOIN's NULL row) it adds nothing.
             COALESCE(sum(least(m.amt, sh.share)) FILTER (WHERE m.member IS NOT NULL), 0),
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
        CROSS JOIN LATERAL (
          SELECT CASE WHEN v_scope = 'user' THEN 'Infinity'::numeric
                      ELSE greatest(0, lim - sp.amt) * p_member_share END AS share
        ) sh
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
