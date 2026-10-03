-- Team isolation for the sandbox wire tables (KOBE-24, spec D5, D13): ENABLE + FORCE RLS and the
-- canonical policy, as in 0001_team_rls.sql.
ALTER TABLE "sandbox_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandbox_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "sandbox_connections"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "sandbox_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandbox_commands" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "sandbox_commands"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "sandbox_run_leases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandbox_run_leases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "sandbox_run_leases"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
-- The durable inbound wire cursor only moves forward (a buggy or replayed writer can't rewind it
-- and make the server accept a frame twice). SECURITY INVOKER, like every Kobe trigger.
CREATE FUNCTION "public"."runs_guard_sandbox_seq"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.sandbox_seq < OLD.sandbox_seq THEN
    RAISE EXCEPTION 'runs.sandbox_seq never decreases (% -> %)', OLD.sandbox_seq, NEW.sandbox_seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "runs_guard_sandbox_seq" BEFORE UPDATE OF "sandbox_seq" ON "runs"
  FOR EACH ROW EXECUTE FUNCTION "public"."runs_guard_sandbox_seq"();
