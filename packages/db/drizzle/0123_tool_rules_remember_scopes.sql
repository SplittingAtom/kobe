-- KOBE-289: remember scopes on user rules. Custom, so db:rebase keeps this SQL as written.
--
-- Existing remember-rules (KOBE-37: 1 day, 30 days or until revoked) get the scope their expiry
-- says: none = until revoked, up to one day = 1 day, anything longer = 30 days. Team rules have
-- none. Then: user rules always carry a known scope, team rules never; `thread_id` is set exactly
-- for `thread` rules and `run_id` exactly for `run` rules (the engine checks the call against them).
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS) and tool_rules has FORCE ROW
-- LEVEL SECURITY with no `kobe.team_id` set, so the UPDATE alone sees no rows and the CHECK below
-- then fails on every existing user rule. FORCE is lifted for the backfill only: the migration is
-- one transaction and ALTER TABLE holds ACCESS EXCLUSIVE until it commits, so nothing else ever
-- sees the table without it (tool-rules-remember-upgrade.db.test.ts).
ALTER TABLE "tool_rules" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "tool_rules"
   SET "remember_scope" = CASE
         WHEN "expires_at" IS NULL THEN 'forever'
         WHEN "expires_at" - "created_at" <= interval '1 day 1 minute' THEN 'day'
         ELSE 'month'
       END
 WHERE "scope" = 'user' AND "remember_scope" IS NULL;--> statement-breakpoint
ALTER TABLE "tool_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_rules" ADD CONSTRAINT "tool_rules_remember_scope" CHECK (
  ("scope" = 'user') = ("remember_scope" IS NOT NULL)
  AND ("remember_scope" IS NULL
       OR "remember_scope" IN ('thread', 'today', 'run', 'day', 'month', 'forever'))
);--> statement-breakpoint
ALTER TABLE "tool_rules" ADD CONSTRAINT "tool_rules_remember_binding" CHECK (
  ("thread_id" IS NOT NULL) = ("remember_scope" IS NOT DISTINCT FROM 'thread')
  AND ("run_id" IS NOT NULL) = ("remember_scope" IS NOT DISTINCT FROM 'run')
);
