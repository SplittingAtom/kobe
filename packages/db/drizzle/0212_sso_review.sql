ALTER TABLE "users" ADD COLUMN "deactivated_via" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "setup_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_setup_owner" ON "users" USING btree ("setup_owner") WHERE "users"."setup_owner";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_deactivated_via" CHECK ("users"."deactivated_via" IS NULL OR "users"."deactivated_via" = 'admin' OR "users"."deactivated_via" ~ '^scim:[0-9a-f-]{36}$');--> statement-breakpoint
-- Backfill (SSO10, review finding 8): the setup Owner from the setup audit event, else the current Owner.
UPDATE "users" SET "setup_owner" = true WHERE "id" = (
  SELECT ("target" ->> 'ownerUserId')::uuid FROM "audit_log"
  WHERE "action" = 'identity.setup.completed'
    AND "target" ->> 'ownerUserId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ORDER BY "seq" LIMIT 1
);--> statement-breakpoint
UPDATE "users" SET "setup_owner" = true
WHERE "id" IN (SELECT "user_id" FROM "site_roles" WHERE "role" = 'owner')
  AND NOT EXISTS (SELECT 1 FROM "users" WHERE "setup_owner");--> statement-breakpoint
-- Deactivations recorded before SSO11 are an admin's: SCIM may not undo them.
UPDATE "users" SET "deactivated_via" = 'admin' WHERE "deactivated_at" IS NOT NULL;
--> statement-breakpoint
-- max_session_hours holds against every refresh of an SSO session's expiry (Better Auth's
-- get-session pushes expires_at forward): the expiry never passes created_at + max hours.
-- Runs as the invoker (no SECURITY DEFINER).
CREATE FUNCTION "kobe_cap_sso_session_expiry"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cap timestamptz;
BEGIN
  SELECT NEW.created_at + make_interval(hours => p.max_session_hours) INTO cap
    FROM public.session_sso_contexts c JOIN public.sso_providers p ON p.id = c.provider_id
   WHERE c.session_id = NEW.id AND p.max_session_hours IS NOT NULL;
  IF cap IS NOT NULL AND NEW.expires_at > cap THEN
    NEW.expires_at := cap;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "sessions_cap_sso_expiry" BEFORE UPDATE OF "expires_at" ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION "kobe_cap_sso_session_expiry"();
