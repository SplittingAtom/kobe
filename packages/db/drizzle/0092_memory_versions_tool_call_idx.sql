-- KOBE-229: the remember handler makes a retried memory.put idempotent by looking up the version
-- that tool call already wrote, by (team_id, run_id, tool_call_id) (services/server
-- src/memory/agent.ts, replayOf). Without an index that lookup scans the team's versions.
--
-- Partial: only an agent's writes carry both a run and a tool call; people's writes have neither,
-- and a panel restore has a `restore:<n>` mark but no run. The lookup's equalities imply the
-- predicate, so the planner uses it with bound parameters and in generic plans.
--
-- Not unique: idempotency is already enforced by the per-call advisory lock and the lookup, and a
-- unique index would fail this migration on any duplicate an install might hold, or would need
-- rows removed. A plain index adds no new failure mode.
--
-- SQL-only, like the retention indexes (0042) and events_schedule_fire_uniq (0087): drizzle runs
-- migrations in one transaction, so it can't be built CONCURRENTLY here. A plain build holds a
-- SHARE lock on memory_doc_versions while it scans: reads go on, writes (new memory versions,
-- restores, cascaded deletes) wait for the build. The table holds one small row per memory write,
-- so this is brief; on a large site, build it beforehand with the same definition and CREATE INDEX
-- CONCURRENTLY, and IF NOT EXISTS then skips it here (docs/install.md, "Upgrading").
CREATE INDEX IF NOT EXISTS "memory_doc_versions_tool_call_idx" ON "memory_doc_versions"
  USING btree ("team_id", "run_id", "tool_call_id")
  WHERE "run_id" IS NOT NULL AND "tool_call_id" IS NOT NULL;
