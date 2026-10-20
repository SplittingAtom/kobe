-- KOBE-338 review D1 (Skills v1.2, SK25): row security for 0163_team_skill_requests. Custom, so
-- db:rebase keeps this SQL as written. The table is new and empty: nothing is backfilled.
--
-- Team isolation, as in 0001_team_rls.sql: ENABLE + FORCE RLS and the canonical policy. Which
-- members read or dismiss requests (the requester; the team's admins) is the server's decision.
ALTER TABLE "team_skill_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_skill_requests"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
