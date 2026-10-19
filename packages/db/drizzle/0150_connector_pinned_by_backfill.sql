-- KOBE-431: connectors.pinned_by for connectors pinned before it existed. Custom, so db:rebase keeps
-- this SQL as written.
--
-- The periodic refresh of a connector that needs a credential probes with the own key of the site
-- admin who last pinned or re-approved it. That admin is the user actor of the connector's latest
-- `mcp.connector.pinned` or `mcp.connector.reapproved` audit event; a connector with none (or whose
-- actor no longer exists) falls back to the admin who registered it. Unpinned connectors stay NULL:
-- their next pin sets it. connectors and audit_log carry no team RLS, so no FORCE dance is needed
-- (connector-pinned-by-upgrade.db.test.ts).
UPDATE "connectors" c
   SET "pinned_by" = COALESCE(
         (SELECT a."actor_id" FROM "audit_log" a
            JOIN "users" u ON u."id" = a."actor_id"
           WHERE a."action" IN ('mcp.connector.pinned', 'mcp.connector.reapproved')
             AND a."actor_kind" = 'user'
             AND a."target" ->> 'connectorId' = c."id"::text
           ORDER BY a."seq" DESC LIMIT 1),
         c."created_by")
 WHERE c."tools_hash" IS NOT NULL AND c."pinned_by" IS NULL;
