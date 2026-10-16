-- KOBE-297: the per-skill usage read (services/server src/skills/usage.ts skillUsageInTx) looks at a
-- team's runs of the last 90 days that used a skill. Custom, so db:rebase keeps this SQL as written;
-- SQL-only (an index is not in the snapshot), declared nowhere in the schema (runs.ts says so).
--
-- The predicate is immutable, and the query repeats it word for word. Its index conditions are
-- team_id (uuid equality) and created_at (timestamptz comparison), both LEAKPROOF, so they stay
-- index conditions for the app role under FORCE ROW LEVEL SECURITY (see 0098).
--
-- Locks: drizzle runs all pending migrations in ONE transaction, and 0101's ADD COLUMN on runs holds
-- an ACCESS EXCLUSIVE lock until commit, so while this plain CREATE INDEX scans runs, reads and
-- writes of runs wait. Every existing row has skills_used = '[]', so the index starts empty, but the
-- scan still reads the table. On a large site, build it beforehand with CREATE INDEX CONCURRENTLY
-- and this definition (docs/install.md, "Upgrading"); IF NOT EXISTS then skips it here.
CREATE INDEX IF NOT EXISTS "runs_skill_uses_idx" ON "runs" ("team_id", "created_at")
  WHERE jsonb_array_length("skills_used") > 0;
