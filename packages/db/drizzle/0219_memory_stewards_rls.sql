-- KOBE-380 (v1.3 Semantic Memory SMA5): team isolation for the Workspace steward table of 0218.
-- Custom, so db:rebase keeps this SQL as written. ENABLE + FORCE RLS and the canonical policy, as
-- in 0217_semantic_memory_rls.sql. No break_glass_read policy (break-glass reads content, and
-- stewards are not content). The table is new and empty. 0218 also added the `memory_steward`
-- value to `site_grant`; nothing in this batch uses it (a new enum value is usable only after the
-- transaction that added it commits).
ALTER TABLE "memory_stewards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_stewards" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "memory_stewards"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
