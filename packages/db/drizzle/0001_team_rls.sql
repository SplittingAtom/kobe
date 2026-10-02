-- Team isolation (spec D5): every team table gets ENABLE + FORCE ROW LEVEL SECURITY and one policy
-- bound to the transaction-local kobe.team_id setting (set by withTeam()). NULLIF makes an unset or
-- reset ('') setting match no rows instead of raising a uuid cast error. FORCE applies the policy to
-- the table owner too. New team tables must follow this pattern; the CI catalog check enforces it.
ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_members"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
