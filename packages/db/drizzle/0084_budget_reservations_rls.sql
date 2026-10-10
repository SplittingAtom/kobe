-- Team isolation for shared budget reservations (KOBE-120, spec D5): ENABLE + FORCE RLS and the
-- canonical policy, as in 0001_team_rls.sql. install_budget_reservations is install-wide (no team
-- or user ids, member key only) and carries no team RLS; the app role's privileges on it come from
-- tenancy/models.ts.
ALTER TABLE "budget_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "budget_reservations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "budget_reservations"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
