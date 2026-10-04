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
