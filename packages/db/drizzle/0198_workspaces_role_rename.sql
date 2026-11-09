-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-577 (Workspaces MG1, PR1): the team role `builder` is renamed `contributor` in place: same
-- rank, same permissions, every team_members and team_invitations row keeps its role. Drizzle
-- cannot generate a value rename (it would drop and recreate the type). Audit payloads are JSON, not
-- this type, so their historical `builder` stays as written.
ALTER TYPE "public"."team_role" RENAME VALUE 'builder' TO 'contributor';
