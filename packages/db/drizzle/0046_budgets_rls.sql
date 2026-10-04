-- Budgets (KOBE-42, spec D5, D30): team isolation for team budgets and daily spend (ENABLE + FORCE
-- RLS, the canonical policy), the install limits row, and the run_usage trigger that keeps the
-- daily spend counters.
ALTER TABLE "team_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_budgets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_budgets"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "model_spend_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_spend_daily" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "model_spend_daily"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
INSERT INTO "install_model_limits" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- Spend (dollars and tokens: input + output + cache reads + cache writes) per (team, UTC day,
-- user) and per UTC day for the install, from each run_usage insert
-- statement (one aggregate per statement, invoker's rights: the team row passes the team's RLS).
CREATE FUNCTION "kobe_count_model_spend"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO "model_spend_daily" ("team_id", "day", "user_id", "cost_usd", "tokens", "calls")
  SELECT "team_id", ("at" AT TIME ZONE 'UTC')::date, "user_id", COALESCE(sum("cost_usd"), 0),
         sum("input_tokens"::bigint + "output_tokens" + "cache_read_tokens" + "cache_write_tokens"), count(*)
    FROM "new_rows" GROUP BY 1, 2, 3
  ON CONFLICT ("team_id", "day", "user_id") DO UPDATE
    SET "cost_usd" = "model_spend_daily"."cost_usd" + EXCLUDED."cost_usd",
        "tokens" = "model_spend_daily"."tokens" + EXCLUDED."tokens",
        "calls" = "model_spend_daily"."calls" + EXCLUDED."calls";
  INSERT INTO "install_model_spend_daily" ("day", "cost_usd", "tokens")
  SELECT ("at" AT TIME ZONE 'UTC')::date, COALESCE(sum("cost_usd"), 0), sum("input_tokens"::bigint + "output_tokens" + "cache_read_tokens" + "cache_write_tokens")
    FROM "new_rows" GROUP BY 1
  ON CONFLICT ("day") DO UPDATE
    SET "cost_usd" = "install_model_spend_daily"."cost_usd" + EXCLUDED."cost_usd",
        "tokens" = "install_model_spend_daily"."tokens" + EXCLUDED."tokens";
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "run_usage_count_spend" AFTER INSERT ON "run_usage"
  REFERENCING NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "kobe_count_model_spend"();--> statement-breakpoint
-- Spend recorded before this migration (KOBE-43 ledger), team by team under each team's RLS.
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT "id" FROM "teams" LOOP
    PERFORM set_config('kobe.team_id', t::text, true);
    INSERT INTO "model_spend_daily" ("team_id", "day", "user_id", "cost_usd", "tokens", "calls")
    SELECT "team_id", ("at" AT TIME ZONE 'UTC')::date, "user_id", COALESCE(sum("cost_usd"), 0),
           sum("input_tokens"::bigint + "output_tokens" + "cache_read_tokens" + "cache_write_tokens"), count(*)
      FROM "run_usage" WHERE "team_id" = t GROUP BY 1, 2, 3
    ON CONFLICT ("team_id", "day", "user_id") DO NOTHING;
    INSERT INTO "install_model_spend_daily" ("day", "cost_usd", "tokens")
    SELECT ("at" AT TIME ZONE 'UTC')::date, COALESCE(sum("cost_usd"), 0), sum("input_tokens"::bigint + "output_tokens" + "cache_read_tokens" + "cache_write_tokens")
      FROM "run_usage" WHERE "team_id" = t GROUP BY 1
    ON CONFLICT ("day") DO UPDATE
      SET "cost_usd" = "install_model_spend_daily"."cost_usd" + EXCLUDED."cost_usd",
          "tokens" = "install_model_spend_daily"."tokens" + EXCLUDED."tokens";
  END LOOP;
  PERFORM set_config('kobe.team_id', '', true);
END $$;
--> statement-breakpoint
-- ── Integrity against the app role (KOBE-42 review). The repo has no SECURITY DEFINER functions,
-- so the app role holds the privileges these triggers need; the guards make each table accept
-- only the writes its owner path makes. A compromised app role can still change budgets through
-- the same statements the admin API uses (audited there): see docs/ledger/KOBE-42.md.

-- 1. Spend counters: written only by the run_usage trigger (trigger depth 2) or a team cascade.
CREATE FUNCTION "kobe_spend_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  -- Moving a team's row elsewhere is the team policy's error (WITH CHECK), not ours.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'model_spend_daily' THEN
    IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
      RETURN NEW;
    END IF;
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION '% is kept by the run_usage trigger only', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "model_spend_daily_guard" BEFORE INSERT OR UPDATE OR DELETE ON "model_spend_daily"
  FOR EACH ROW EXECUTE FUNCTION "kobe_spend_guard"();--> statement-breakpoint
CREATE TRIGGER "install_model_spend_daily_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "install_model_spend_daily"
  FOR EACH ROW EXECUTE FUNCTION "kobe_spend_guard"();--> statement-breakpoint

-- 2. A budget alert records a threshold really crossed: the current UTC period, the limit as
-- configured now (a member without a budget of their own: the team's default member budget),
-- and the spend recomputed from the counters (the row's own amount is replaced).
CREATE FUNCTION "kobe_budget_alert_verify"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
DECLARE
  today date := (now() AT TIME ZONE 'UTC')::date;
  start date;
  configured numeric;
  actual numeric;
  own boolean;
BEGIN
  start := CASE NEW.period WHEN 'month' THEN date_trunc('month', today)::date ELSE today END;
  IF NEW.period_start IS DISTINCT FROM start THEN
    RAISE EXCEPTION 'budget alert: not the current period' USING ERRCODE = '23514';
  END IF;
  IF NEW.scope = 'install' THEN
    SELECT CASE WHEN NEW.unit = 'usd' THEN
                  CASE WHEN NEW.period = 'month' THEN l.monthly_usd ELSE l.daily_usd END
                ELSE CASE WHEN NEW.period = 'month' THEN l.monthly_tokens ELSE l.daily_tokens END END
      INTO configured FROM "install_model_limits" l WHERE l.id = 1;
    SELECT COALESCE(sum(CASE WHEN NEW.unit = 'usd' THEN s.cost_usd ELSE s.tokens END), 0)
      INTO actual FROM "install_model_spend_daily" s WHERE s.day BETWEEN start AND today;
  ELSE
    IF NEW.team_id IS DISTINCT FROM NULLIF(current_setting('kobe.team_id', true), '')::uuid THEN
      RAISE EXCEPTION 'budget alert: outside its team' USING ERRCODE = '42501';
    END IF;
    IF NEW.scope = 'user' THEN
      SELECT EXISTS (SELECT 1 FROM "team_budgets" b
                      WHERE b.team_id = NEW.team_id AND b.user_id = NEW.user_id) INTO own;
    END IF;
    SELECT CASE
             WHEN NEW.scope = 'user' AND NOT own THEN
               CASE WHEN NEW.unit = 'usd' THEN
                      CASE WHEN NEW.period = 'month' THEN b.member_monthly_usd ELSE b.member_daily_usd END
                    ELSE CASE WHEN NEW.period = 'month' THEN b.member_monthly_tokens ELSE b.member_daily_tokens END END
             ELSE
               CASE WHEN NEW.unit = 'usd' THEN
                      CASE WHEN NEW.period = 'month' THEN b.monthly_usd ELSE b.daily_usd END
                    ELSE CASE WHEN NEW.period = 'month' THEN b.monthly_tokens ELSE b.daily_tokens END END
           END
      INTO configured
      FROM "team_budgets" b
     WHERE b.team_id = NEW.team_id
       AND b.user_id IS NOT DISTINCT FROM
           (CASE WHEN NEW.scope = 'user' AND own THEN NEW.user_id END);
    SELECT COALESCE(sum(CASE WHEN NEW.unit = 'usd' THEN s.cost_usd ELSE s.tokens END), 0)
      INTO actual FROM "model_spend_daily" s
     WHERE s.team_id = NEW.team_id AND s.day BETWEEN start AND today
       AND (NEW.scope = 'team' OR s.user_id = NEW.user_id);
  END IF;
  IF configured IS NULL OR NEW.limit_amount IS DISTINCT FROM configured THEN
    RAISE EXCEPTION 'budget alert: no such budget' USING ERRCODE = '23514';
  END IF;
  NEW.spent_amount := actual;
  NEW.created_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "budget_alerts_verify" BEFORE INSERT ON "budget_alerts"
  FOR EACH ROW EXECUTE FUNCTION "kobe_budget_alert_verify"();--> statement-breakpoint

-- 3. Its emails come only with a verified alert: team admins (and the member, for a member
-- budget), or the install admins for the install budget.
CREATE FUNCTION "kobe_budget_alert_emails"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.scope = 'install' THEN
    INSERT INTO "budget_alert_emails" ("alert_id", "recipient_id")
    SELECT NEW.id, r.user_id FROM "install_roles" r JOIN "users" u ON u.id = r.user_id
     WHERE u.deactivated_at IS NULL
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO "budget_alert_emails" ("alert_id", "recipient_id")
    SELECT NEW.id, m.user_id FROM "team_members" m JOIN "users" u ON u.id = m.user_id
     WHERE m.team_id = NEW.team_id AND m.role = 'team_admin' AND u.deactivated_at IS NULL
    UNION
    SELECT NEW.id, u.id FROM "users" u
     WHERE NEW.scope = 'user' AND u.id = NEW.user_id AND u.deactivated_at IS NULL
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "budget_alerts_emails" AFTER INSERT ON "budget_alerts"
  FOR EACH ROW EXECUTE FUNCTION "kobe_budget_alert_emails"();--> statement-breakpoint
CREATE FUNCTION "kobe_budget_email_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'budget alert emails come only with a budget alert' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "budget_alert_emails_guard" BEFORE INSERT ON "budget_alert_emails"
  FOR EACH ROW EXECUTE FUNCTION "kobe_budget_email_guard"();--> statement-breakpoint

-- 4. A team's alerts (and their emails) are visible in its own context only; the install's
-- everywhere (amounts and ids, no team content).
ALTER TABLE "budget_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "budget_alerts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "budget_alerts_team" ON "budget_alerts"
  USING ("team_id" IS NULL OR "team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" IS NULL OR "team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "budget_alert_emails" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "budget_alert_emails" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "budget_alert_emails_alert" ON "budget_alert_emails"
  USING (EXISTS (SELECT 1 FROM "budget_alerts" a WHERE a.id = "alert_id"))
  WITH CHECK (EXISTS (SELECT 1 FROM "budget_alerts" a WHERE a.id = "alert_id"));--> statement-breakpoint

-- 5. The install limits are changed by an active install admin only (the id is asserted by the
-- server, not authenticated: residual risk in the ledger), and stamped now.
CREATE FUNCTION "kobe_install_limits_guard"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "install_roles" r JOIN "users" u ON u.id = r.user_id
                  WHERE r.user_id = NEW.updated_by AND u.deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'install limits are changed by an install admin' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "install_model_limits_guard" BEFORE UPDATE ON "install_model_limits"
  FOR EACH ROW EXECUTE FUNCTION "kobe_install_limits_guard"();
