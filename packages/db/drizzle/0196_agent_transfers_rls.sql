-- KOBE-568 (agents-roster AR10): team isolation for agent_transfers (0195). Custom, so db:rebase
-- keeps this SQL as written. The canonical policy, as in 0194_agent_roster_rls.sql; the table is
-- new and empty.
ALTER TABLE "agent_transfers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_transfers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "agent_transfers"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
