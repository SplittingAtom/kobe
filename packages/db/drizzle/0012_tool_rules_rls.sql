-- Team isolation for team and user tool rules (spec D5, D29): ENABLE + FORCE RLS and the canonical
-- policy, as in 0001_team_rls.sql. install_tool_rules is install-wide (the policy floor).
ALTER TABLE "tool_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "tool_rules"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
