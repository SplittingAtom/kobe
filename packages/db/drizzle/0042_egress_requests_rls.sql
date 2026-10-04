-- Team isolation for request access and its email outbox (KOBE-39, spec D5, D28): ENABLE + FORCE
-- RLS and the canonical policy, as in 0001_team_rls.sql.
ALTER TABLE "egress_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "egress_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "egress_requests"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "egress_request_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "egress_request_notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "egress_request_notifications"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
