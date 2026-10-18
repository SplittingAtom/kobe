-- KOBE-420: runs.agent_version for runs that started before it existed. Custom, so db:rebase keeps
-- this SQL as written.
--
-- The version a run started on is in its `run.started` event (`payload.agent_version`), until the
-- D18 compaction folds the run's events away 7 days after it ended: those runs stay NULL (the chat
-- skips them when it marks version changes).
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS), and runs and run_events have FORCE
-- ROW LEVEL SECURITY with no `kobe.team_id` set, so the UPDATE alone would see no rows. FORCE is
-- lifted for the backfill only: the migration is one transaction and ALTER TABLE holds ACCESS
-- EXCLUSIVE until it commits, so nothing else ever sees either table without it
-- (runs-agent-version-upgrade.db.test.ts). One `run_events` primary-key range per started,
-- uncompacted run; compacted runs are skipped without a lookup.
ALTER TABLE "runs" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_events" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "runs" r
   SET "agent_version" = s.version
  FROM (
    SELECT r0."team_id", r0."id",
           (SELECT (e."payload" ->> 'agent_version')::int FROM "run_events" e
             WHERE e."team_id" = r0."team_id" AND e."run_id" = r0."id"
               AND e."type" = 'run.started'
               AND (e."payload" ->> 'agent_version') ~ '^[1-9][0-9]{0,8}$'
             ORDER BY e."seq" LIMIT 1) AS version
      FROM "runs" r0
     WHERE r0."started_at" IS NOT NULL AND r0."events_compacted_at" IS NULL
       AND r0."agent_version" IS NULL
  ) s
 WHERE r."team_id" = s."team_id" AND r."id" = s."id" AND s.version IS NOT NULL;--> statement-breakpoint
ALTER TABLE "run_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runs" FORCE ROW LEVEL SECURITY;
