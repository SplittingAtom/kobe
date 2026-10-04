-- Team isolation for the model usage ledger (KOBE-43, spec D5, D30): ENABLE + FORCE RLS and the
-- canonical policy, as in 0001_team_rls.sql.
ALTER TABLE "run_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_usage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "run_usage"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
--> statement-breakpoint
-- The ledger is append-only (KOBE-43 review): budgets (KOBE-42) sum it, so no app path may change
-- or remove a row. Only a cascade (a team deleted: trigger depth > 1) may delete rows.
CREATE FUNCTION "kobe_run_usage_append_only"() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  -- Moving a row to another team is refused by the team policy's WITH CHECK (the RLS error).
  IF TG_OP = 'UPDATE' AND NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'run_usage is append-only' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER "run_usage_append_only" BEFORE UPDATE OR DELETE ON "run_usage"
  FOR EACH ROW EXECUTE FUNCTION "kobe_run_usage_append_only"();
