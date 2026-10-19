-- KOBE-433 review (HIGH-2): connector_ui_resources.approved for rows written before it existed.
-- Custom, so db:rebase keeps this SQL as written.
--
-- A row was approved by a site admin when it is pinned, or drifted with a proposal (its html is
-- the approved bytes). A drifted row with no proposal is new upstream and was never approved, so it
-- keeps the column default (false). The table is site-wide (no team RLS), so no FORCE dance is
-- needed (connector-ui-resources-upgrade.db.test.ts).
UPDATE "connector_ui_resources"
   SET "approved" = true
 WHERE "status" = 'pinned' OR "proposed" IS NOT NULL;
