-- KOBE-454: a removed connector's secrets do not outlive it. Removal is a soft delete (deleted_at),
-- so the ON DELETE CASCADE of connector_site_keys and connector_grants never fired, and connectors
-- removed before this release still hold their sealed site key and members' grants (API keys,
-- OAuth tokens). From this release the server deletes both in the removal's transaction; this
-- deletes what earlier removals left. Idempotent: a second run finds nothing. Custom, so db:rebase
-- keeps this SQL as written.
--
-- Legal hold (D18) does not apply to grants or site keys: they are credentials, not retained team
-- content (0076_connector_grants_rls.sql). Not audited row by row (the server's removal audit
-- carries counts from now on); the connectors stay, soft-deleted, for audit history and foreign keys.
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS) and connector_grants has FORCE ROW
-- LEVEL SECURITY with no `kobe.team_id` set, so FORCE is lifted for the delete only (one
-- transaction; ALTER TABLE holds its lock until commit, so nothing else sees the table without it).
-- (removed-connector-credentials-upgrade.db.test.ts migrates a database with such rows.)
DELETE FROM "connector_site_keys" k
 USING "connectors" c
 WHERE c."id" = k."connector_id" AND c."deleted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_grants" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM "connector_grants" g
 USING "connectors" c
 WHERE c."id" = g."connector_id" AND c."deleted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_grants" FORCE ROW LEVEL SECURITY;
