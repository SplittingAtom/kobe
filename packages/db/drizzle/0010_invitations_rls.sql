-- Team isolation for team_invitations (spec D5): ENABLE + FORCE RLS and the canonical policy, as in
-- 0001_team_rls.sql.
ALTER TABLE "team_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_invitations"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint

-- Deactivation (KOBE-13, spec D7): no session may be created for a deactivated user, by any sign-in
-- method. The server also refuses in Better Auth's session hook (for a clean error); this trigger
-- closes the race with a concurrent deactivation. FOR SHARE conflicts with the deactivating UPDATE
-- of the user row, so either this insert waits and then sees deactivated_at set (and fails), or the
-- deactivation waits for this insert to commit and then deletes the new session in the same
-- transaction. Runs as the invoker (no SECURITY DEFINER).
CREATE FUNCTION "kobe_refuse_deactivated_session"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM "public"."users" WHERE "id" = NEW."user_id" AND "deactivated_at" IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account is deactivated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "sessions_refuse_deactivated" BEFORE INSERT OR UPDATE OF "user_id" ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION "kobe_refuse_deactivated_session"();
