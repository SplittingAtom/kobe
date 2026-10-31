-- KOBE-531: apps the KOBE-460 name rule put in the rail's Pickers keep their place on deploy.
-- Custom, so db:rebase keeps this SQL as written.
--
-- The rule matched an app's display title containing "Picker" in any case. The title came from
-- the opening tool (its `title`, its annotations' title, or its name made readable) or the pinned
-- template's `<title>` (searched in the head, the first 64 KiB as the server reads it). Any of
-- those containing "picker" makes the row `rail`; every other row keeps the default `chat`. The
-- table is site-wide (no team RLS), so no FORCE dance is needed
-- (connector-ui-resources-placement-upgrade.db.test.ts).
UPDATE "connector_ui_resources" r
   SET "placement" = 'rail'
 WHERE left(r."html", 65536) ~* '<title(\s[^>]*)?>[^<]*picker'
    OR EXISTS (
         SELECT 1
           FROM "connectors" c,
                jsonb_array_elements(c."tools_snapshot") t
          WHERE c."id" = r."connector_id"
            AND jsonb_typeof(t) = 'object'
            AND t -> 'ui' ->> 'resource_uri' = r."uri"
            AND (t ->> 'title' ILIKE '%picker%'
                 OR t -> 'annotations' ->> 'title' ILIKE '%picker%'
                 OR t ->> 'name' ILIKE '%picker%')
       );
