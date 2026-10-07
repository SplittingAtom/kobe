-- Run tokens die with the run (KOBE-118): the one choke point is the runs row itself. Any update
-- that leaves a run in a status other than running / waiting_approval (completed, failed,
-- interrupted, cancelled, budget_stopped, or back to queued) revokes its live tokens, whichever
-- code path made it. Invoker's rights: the app role may update run_tokens inside the team context
-- that updates the run (RLS applies as for any other statement).
CREATE FUNCTION "public"."run_tokens_revoke_on_run_end"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "run_tokens" SET "revoked_at" = now()
   WHERE "team_id" = NEW."team_id" AND "run_id" = NEW."id" AND "revoked_at" IS NULL;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "runs_revoke_run_tokens"
  AFTER UPDATE OF "status" ON "runs"
  FOR EACH ROW
  WHEN (NEW."status" NOT IN ('running', 'waiting_approval') AND OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "public"."run_tokens_revoke_on_run_end"();
