ALTER TABLE "users" ADD COLUMN "deactivated_via" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "setup_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
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
